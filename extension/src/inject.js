/* inject.js — MAIN world.

   АРХИТЕКТУРА (0.6.0). Плеер Яндекса получает звук так: зашифрованный поток
   (`transport: "encraw"`, `/music-v2/crypt/ysign1=...`) расшифровывается в JS,
   и элемент получает СОБСТВЕННЫЙ blob: URL. Любая попытка подменить `src`
   вступает с плеером в гонку: он ставит свой blob, мы свой, он снова свой —
   элемент никогда не доходит до готовности, и трек не запускается.

   Поэтому элемент плеера НЕ ТРОГАЕМ. Вместо этого:
     • глушим элемент плеера (muted),
     • играем свою копию в отдельном собственном элементе,
     • зеркалим громкость, скорость, позицию и паузу.

   Нормализации здесь нет: ключ трека считает service worker. */
(function () {
  'use strict';
  if (window.__ymuInjected) return;
  window.__ymuInjected = true;

  const EVT_OUT = 'ymu:to-bridge';
  const EVT_IN = 'ymu:to-page';

  /* ---------- состояние ---------- */

  const settings = { enabled: true, badge: true, capture: false, insertEnabled: false, insertOnSkip: true };
  const local = new Map();       // key -> {url, size, mime}
  const transfers = new Map();   // transferId -> {key, parts, mime, lastAt}
  const pending = new Map();     // reqId -> callback

  /** Медиаэлементы самого плеера. Наши собственные сюда не попадают. */
  const media = new Map();       // element -> {firstSeen, playing}

  let currentKey = null;
  let lastInfo = null;            // последний трек, который показывал плеер
  let lastSignature = '';
  let status = { text: 'ожидание трека', tone: 'idle' };
  let reqSeq = 0;
  let resolveInFlight = false;

  /** Наш элемент, которым мы играем локальный файл. */
  let shadow = null;             // { el, key, url }
  let shadowMutedPlayer = null;  // элемент плеера, который мы заглушили

  /* ---------- транспорт ---------- */

  function post(obj) {
    try {
      window.dispatchEvent(new CustomEvent(EVT_OUT, { detail: JSON.stringify(obj) }));
    } catch (e) { /* ignore */ }
  }

  function request(type, payload, timeoutMs) {
    const reqId = 'q' + (++reqSeq);
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        pending.delete(reqId);
        resolve(null);
      }, timeoutMs || 5000);

      pending.set(reqId, (data) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pending.delete(reqId);
        resolve(data);
      });

      post({ type, reqId, payload: payload || null });
    });
  }

  /* ---------- бейдж ---------- */

  let badgeEl = null;
  let badgeText = null;
  let badgeBtn = null;
  let badgeAction = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function ensureBadgeEl() {
    if (badgeEl && badgeEl.isConnected) return;
    badgeEl = document.createElement('div');
    badgeEl.id = 'ymu-badge';
    // по умолчанию — над баром плеера, а не поверх него; позицию можно перетащить
    let pos = { left: 12, bottom: 110 };
    try { pos = Object.assign(pos, JSON.parse(localStorage.getItem('ymu-badge-pos') || '{}')); } catch (e) {}
    badgeEl.style.cssText = [
      'position:fixed', `left:${pos.left}px`, `bottom:${pos.bottom}px`, 'z-index:2147483647',
      'padding:5px 9px', 'border-radius:7px',
      'font:11px/1.35 -apple-system,Segoe UI,Roboto,sans-serif',
      'background:rgba(20,21,26,.92)', 'color:#cfd3de',
      'border:1px solid #3a3f4f', 'cursor:move', 'user-select:none',
      'max-width:380px', 'white-space:normal',
    ].join(';');
    badgeEl.title = 'YM Uncensored — перетащи, чтобы подвинуть';
    makeDraggable(badgeEl);
    badgeText = document.createElement('span');
    // кнопка живёт постоянно: если пересоздавать её на каждом тике, клик теряется
    badgeBtn = document.createElement('button');
    badgeBtn.style.cssText = [
      'margin-left:8px', 'pointer-events:auto', 'cursor:pointer',
      'background:#2b2f3c', 'color:#e6e7ea', 'border:1px solid #3a3f4f',
      'border-radius:5px', 'font:inherit', 'padding:1px 7px', 'display:none',
    ].join(';');
    badgeBtn.addEventListener('click', (e) => {
      try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
      if (badgeAction) badgeAction();
    });
    badgeEl.appendChild(badgeText);
    badgeEl.appendChild(badgeBtn);
    (document.body || document.documentElement).appendChild(badgeEl);
  }

  function makeDraggable(el) {
    try {
      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || (badgeBtn && e.target === badgeBtn)) return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top;
        const move = (ev) => {
          const left = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx));
          const top = Math.max(0, Math.min(innerHeight - r.height, ev.clientY - dy));
          el.style.left = left + 'px';
          el.style.bottom = Math.round(innerHeight - top - r.height) + 'px';
        };
        const up = () => {
          window.removeEventListener('mousemove', move, true);
          window.removeEventListener('mouseup', up, true);
          try {
            localStorage.setItem('ymu-badge-pos', JSON.stringify({
              left: parseInt(el.style.left, 10) || 0, bottom: parseInt(el.style.bottom, 10) || 0 }));
          } catch (err) { /* ignore */ }
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
      });
    } catch (e) { /* ignore */ }
  }

  /** action: необязательная кнопка на плашке { label, fn }. */
  function badge(text, tone, action) {
    status = { text, tone: tone || 'idle' };
    if (!settings.badge) { if (badgeEl && badgeEl.style) badgeEl.style.display = 'none'; return; }
    try {
      ensureBadgeEl();
      badgeEl.style.display = 'block';
      const colors = { ok: '#7ee27e', warn: '#e8c47a', bad: '#ff8f8f', idle: '#8b8f9c', insert: '#c9a6ff' };
      let html = `<b style="color:${colors[tone] || colors.idle}">YMU</b> ${escapeHtml(text)}`;
      // вторая строка — что сейчас со вставкой и почему (раньше это было не видно)
      if (tone !== 'insert' && settings.enabled && settings.insertEnabled && insertNote) {
        html += `<br><span style="color:${colors.insert}">вставка: ${escapeHtml(insertNote)}</span>`;
      }
      if (badgeText.__html !== html) { badgeText.innerHTML = html; badgeText.__html = html; }
      badgeAction = action ? action.fn : null;
      if (action) {
        if (badgeBtn.textContent !== action.label) badgeBtn.textContent = action.label;
        badgeBtn.style.display = 'inline-block';
      } else {
        badgeBtn.style.display = 'none';
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- реестр элементов плеера ---------- */

  const MEDIA_TAGS = { AUDIO: 1, VIDEO: 1 };
  const origCreateElement = Document.prototype.createElement;
  const origPlay = HTMLMediaElement.prototype.play;
  const origPause = HTMLMediaElement.prototype.pause;

  function isMedia(el) {
    return el && MEDIA_TAGS[el.tagName] === 1;
  }

  function remember(el) {
    if (!isMedia(el) || el.__ymuOwn || media.has(el)) return;
    media.set(el, { firstSeen: Date.now(), playing: false });
    // Слушатель вешаем в момент создания — раньше, чем свои повесит плеер.
    // Так мы узнаём о естественном конце трека до того, как плеер запустит следующий.
    try { el.addEventListener('ended', () => onPlayerEnded(el)); } catch (e) { /* ignore */ }
  }

  try {
    Document.prototype.createElement = function (tag) {
      const el = origCreateElement.apply(this, arguments);
      try { if (typeof tag === 'string' && MEDIA_TAGS[tag.toUpperCase()]) remember(el); } catch (e) {}
      return el;
    };
  } catch (e) { /* ignore */ }

  try {
    const OrigAudio = window.Audio;
    if (typeof OrigAudio === 'function') {
      const Patched = function (...args) {
        const el = new OrigAudio(...args);
        try { remember(el); } catch (e) {}
        return el;
      };
      Patched.prototype = OrigAudio.prototype;
      Object.setPrototypeOf(Patched, OrigAudio);
      window.Audio = Patched;
    }
  } catch (e) { /* ignore */ }

  try {
    HTMLMediaElement.prototype.play = function () {
      try {
        if (!this.__ymuOwn) {
          remember(this);
          const rec = media.get(this);
          if (rec) rec.playing = true;
          // во время вставки кнопка «играть» плеера управляет вставкой
          const held = insertOnPlay(this);
          if (held) return held;
        }
      } catch (e) { /* ignore */ }
      return origPlay.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }

  try {
    HTMLMediaElement.prototype.pause = function () {
      try { if (!this.__ymuOwn) insertOnPause(this); } catch (e) { /* ignore */ }
      return origPause.apply(this, arguments);
    };
  } catch (e) { /* ignore */ }

  function scanDom() {
    try {
      const walk = (root) => {
        if (!root || !root.querySelectorAll) return;
        for (const el of root.querySelectorAll('audio, video')) remember(el);
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
    } catch (e) { /* ignore */ }
  }

  /** Элемент плеера, который реально играет (или готов играть). */
  function playerMedia() {
    let playing = null, withSrc = null;
    for (const [el, rec] of media) {
      if (el.__ymuOwn) continue;
      if (!el.paused && el.currentTime > 0) return el;
      if (!el.paused && !playing) playing = el;
      if (el.src || el.srcObject) { if (!withSrc) withSrc = el; }
    }
    return playing || withSrc;
  }

  /* ---------- собственный элемент ---------- */

  function ensureShadow() {
    if (shadow && shadow.el) return shadow;
    let el;
    try {
      // создаём в обход своего же перехвата и помечаем как собственный
      el = origCreateElement.call(document, 'audio');
    } catch (e) {
      return null;
    }
    el.__ymuOwn = true;
    el.preload = 'auto';
    media.delete(el);

    el.addEventListener('error', () => {
      const code = el.error && el.error.code;
      badge(`локальный файл не декодируется (код ${code}) — вернул оригинал`, 'bad');
      failCurrentKey('файл не декодируется');
    });

    shadow = { el, key: null, url: null };
    return shadow;
  }

  /* ---------- приём из bridge ---------- */

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function onBridgeEvent(e) {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }

    if (msg.kind === 'reply' && msg.reqId && pending.has(msg.reqId)) {
      pending.get(msg.reqId)(msg.data);
      return;
    }

    switch (msg.kind) {
      case 'state':
        if (msg.data && msg.data.settings) {
          const s = msg.data.settings;
          if (typeof s.enabled === 'boolean') settings.enabled = s.enabled;
          if (typeof s.badge === 'boolean') settings.badge = s.badge;
          if (typeof s.capture === 'boolean') settings.capture = s.capture;
          if (typeof s.insertEnabled === 'boolean') settings.insertEnabled = s.insertEnabled;
          if (typeof s.insertOnSkip === 'boolean') settings.insertOnSkip = s.insertOnSkip;
        }
        break;

      case 'insertNext':
        forceInsert();
        break;

      case 'probe':
        try { post({ type: 'probeResult', payload: probeBar() }); } catch (e) { /* ignore */ }
        break;

      case 'audioStart':
        transfers.set(msg.data.transferId, {
          key: msg.data.key, parts: [], mime: msg.data.mime,
          total: msg.data.size || 0, startedAt: Date.now(), lastAt: Date.now(),
        });
        // файл вставки грузится заранее и молча: плашка показывает текущий трек
        if (!isInsertKey(msg.data.key)) badge('получаю файл… 0%', 'idle');
        break;

      case 'audioProgress': {
        const tp = transfers.get(msg.data.transferId);
        if (tp) tp.lastAt = Date.now();
        if (!isInsertKey(msg.data.key)) badge(`получаю файл… ${msg.data.percent}%`, 'idle');
        break;
      }

      case 'audioChunk': {
        const t = transfers.get(msg.data.transferId);
        if (!t) break;
        try { t.parts.push(b64ToBytes(msg.data.data)); } catch (err) { break; }
        t.lastAt = Date.now();
        break;
      }

      case 'audioDone': {
        const t = transfers.get(msg.data.transferId);
        if (!t) break;
        transfers.delete(msg.data.transferId);
        try {
          const mime = t.mime || 'audio/mpeg';
          const blob = new Blob(t.parts, { type: mime });
          if (isInsertKey(t.key)) {
            // вставку уже отменили, пока файл ехал, — не держим его в памяти
            if (!insert || insert.key !== t.key) break;
            local.set(t.key, { url: URL.createObjectURL(blob), size: blob.size, mime });
            break;
          }
          const prev = local.get(t.key);
          if (prev && prev.url) URL.revokeObjectURL(prev.url);
          local.set(t.key, { url: URL.createObjectURL(blob), size: blob.size, mime });
          badge(`файл готов (${Math.round(blob.size / 1024)} КБ)`, 'ok');
          sync();
        } catch (err) {
          badge('не собрал Blob: ' + (err && err.message), 'bad');
        }
        break;
      }

      case 'audioError':
        badge('ошибка файла: ' + ((msg.data && msg.data.error) || '?'), 'bad');
        transfers.delete(msg.data && msg.data.transferId);
        break;
    }
  }

  window.addEventListener(EVT_IN, onBridgeEvent);

  /* ---------- определение трека ---------- */

  function fromMediaSession() {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (md && (md.title || md.artist)) {
        return { title: md.title || '', artists: md.artist || '', album: md.album || '', via: 'mediaSession' };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function fromDom() {
    try {
      const bars = document.querySelectorAll(
        '[class*="PlayerBar"], [class*="player-controls"], [class*="PlayerControls"], [data-testid*="player"]'
      );
      for (const bar of bars) {
        const link = bar.querySelector('a[href*="/track/"]');
        if (!link) continue;
        const title = (link.textContent || '').trim();
        if (!title) continue;
        let artists = '';
        const a = bar.querySelector('a[href*="/artist/"]');
        if (a) artists = (a.textContent || '').trim();
        return { title, artists, album: '', via: 'DOM:playerBar' };
      }

      const links = document.querySelectorAll('a[href*="/track/"]');
      if (links.length) {
        const link = links[links.length - 1];
        const title = (link.textContent || '').trim();
        if (title) {
          let artists = '';
          const wrap = link.closest && link.closest('[class*="track"], [class*="Track"], li, div');
          if (wrap) {
            const a = wrap.querySelector('a[href*="/artist/"]');
            if (a) artists = (a.textContent || '').trim();
          }
          return { title, artists, album: '', via: 'DOM:lastTrackLink' };
        }
      }

      const dt = (document.title || '').replace(/\s*[—–-]\s*Яндекс\.?\s*Музыка.*$/i, '').trim();
      if (dt && dt.includes('—')) {
        const parts = dt.split(/\s*[—–]\s*/);
        if (parts[0] && parts[1]) return { title: parts[0].trim(), artists: parts[1].trim(), album: '', via: 'DOM:title' };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function looseEq(a, b) {
    const n = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return n(a) === n(b);
  }

  function collectInfo() {
    const ms = fromMediaSession();
    const dom = fromDom();
    let title = '', artists = '', album = '';
    const via = [];

    if (ms && ms.title) {
      title = ms.title; artists = ms.artists || ''; album = ms.album || '';
      via.push(ms.via);
    }
    if (dom && dom.title) {
      if (!title) {
        title = dom.title; artists = dom.artists || ''; album = dom.album || '';
        via.push(dom.via);
      } else if (!artists && looseEq(dom.title, title)) {
        artists = dom.artists || '';
        if (artists) via.push(dom.via);
      }
    }
    if (!title) return null;
    if (!artists) via.push('артист не определён');
    return { title, artists, album, via: via.join(' + ') || '?' };
  }

  function mediaDuration() {
    const p = playerMedia();
    if (p && isFinite(p.duration) && p.duration > 0) return Math.round(p.duration * 1000);
    return 0;
  }

  function pollTrack() {
    // во время вставки mediaSession и бар плеера показывают её, а не трек Яндекса
    if (insert && insert.phase === 'playing') return;
    const info = collectInfo();
    if (!info || !info.title) {
      if (lastSignature !== '__none__') {
        lastSignature = '__none__';
        currentKey = null;
        badge('трек не определён — включи воспроизведение', 'warn');
      }
      return;
    }

    lastInfo = info;
    const sig = info.artists + '|' + info.title;
    if (sig === lastSignature || resolveInFlight) return;
    lastSignature = sig;

    const prevKey = currentKey;
    currentKey = null;
    stopShadow('смена трека');

    const who = info.artists ? `${info.artists} — ${info.title}` : `? — ${info.title}`;
    badge(`${who} · ищу файл`, 'idle');
    resolveInFlight = true;

    request('track', {
      title: info.title,
      artists: info.artists,
      album: info.album || '',
      durationMs: mediaDuration(),
      via: info.via,
    }).then((res) => {
      resolveInFlight = false;
      if (!res || !res.ok) {
        badge('фон не ответил — проверь, что расширение включено', 'bad');
        return;
      }
      currentKey = res.key;

      if (typeof res.enabled === 'boolean') {
        settings.enabled = res.enabled;
        if (!res.enabled) {
          stopShadow('выключено в настройках');
          badge(`${res.key} · ${res.reason || 'выключено'}`, 'warn');
          return;
        }
      }

      if (res.fileId) {
        if (local.has(res.key)) {
          sync();
        } else {
          badge('файл найден, загружаю', 'idle');
          request('needAudio', { key: res.key, fileId: res.fileId });
        }
      } else {
        badge(`${res.key} · ${res.reason || 'файла нет'}`, 'warn');
      }
      if (prevKey && prevKey !== res.key) stopShadow('смена ключа');
    });
  }

  /* ---------- параллельное воспроизведение ---------- */

  /**
   * Синхронизация: глушим плеер и играем свою копию.
   * Вызывается по таймеру — это дешёвая операция, пока состояние совпадает.
   */
  function sync() {
    try {
      // идёт вставка: плеер придержан, копия трека молчит
      if (insert && insert.phase === 'playing') {
        if (shadow && shadow.el && !shadow.el.paused) shadow.el.pause();
        return;
      }
      const player = playerMedia();

      const rec = settings.enabled && currentKey ? local.get(currentKey) : null;
      if (!player || !rec) {
        stopShadow('нет условий');
        return;
      }

      const sh = ensureShadow();
      if (!sh) return;
      const el = sh.el;

      // свой файл под текущий ключ
      if (sh.key !== currentKey || sh.url !== rec.url) {
        if (sh.url && sh.url !== rec.url) URL.revokeObjectURL(sh.url);
        sh.key = currentKey;
        sh.url = rec.url;
        el.src = rec.url;
        try { el.load(); } catch (e) { /* ignore */ }
      }

      // формат проверяем ДО того, как глушить плеер: иначе останемся без звука вовсе
      const probe = typeof el.canPlayType === 'function' ? String(el.canPlayType(rec.mime || 'audio/mpeg')) : '';
      if (el.canPlayType && probe === '') {
        failCurrentKey(`формат не поддерживается: ${rec.mime}`);
        return;
      }

      // глушим плеер
      if (player !== shadowMutedPlayer) {
        if (shadowMutedPlayer && shadowMutedPlayer.__ymuWasMuted !== undefined) {
          try { shadowMutedPlayer.muted = shadowMutedPlayer.__ymuWasMuted; } catch (e) {}
          delete shadowMutedPlayer.__ymuWasMuted;
        }
        if (player.__ymuWasMuted === undefined) player.__ymuWasMuted = !!player.muted;
        shadowMutedPlayer = player;
      }
      if (!player.muted) player.muted = true;

      // зеркалим громкость/скорость
      const vol = player.__ymuWasMuted ? 0 : player.volume;
      if (Math.abs((el.volume ?? 1) - vol) > 0.001) el.volume = vol;
      if (Math.abs((el.playbackRate ?? 1) - (player.playbackRate || 1)) > 0.001) {
        el.playbackRate = player.playbackRate || 1;
      }

      // пауза/игра
      if (player.paused) {
        if (!el.paused) el.pause();
        badge(`пауза · ${currentKey}`, 'idle');
        return;
      }

      // рассинхрон: подтягиваем позицию
      const drift = Math.abs((el.currentTime || 0) - (player.currentTime || 0));
      if (drift > 0.4) {
        try { el.currentTime = player.currentTime || 0; } catch (e) { /* ignore */ }
      }

      if (el.paused) {
        const p = origPlay.call(el);
        if (p && p.catch) {
          p.catch((err) => {
            badge(`не удалось запустить копию: ${(err && err.name) || 'ошибка'} — вернул оригинал`, 'bad');
            stopShadow('play() отклонён');
          });
        }
      }

      // успех объявляем только если копия реально играет
      if (!el.paused) badge(`играет локальная версия · ${currentKey}`, 'ok');
    } catch (e) {
      badge('сбой синхронизации: ' + (e && e.message), 'bad');
    }
  }

  function stopShadow(reason) {
    try {
      if (shadowMutedPlayer) {
        if (shadowMutedPlayer.__ymuWasMuted !== undefined) {
          shadowMutedPlayer.muted = shadowMutedPlayer.__ymuWasMuted;
          delete shadowMutedPlayer.__ymuWasMuted;
        }
        shadowMutedPlayer = null;
      }
      if (shadow && shadow.el) {
        try { shadow.el.pause(); } catch (e) {}
        try { shadow.el.removeAttribute('src'); shadow.el.load(); } catch (e) {}
        shadow.key = null;
        shadow.url = null;
      }
      if (reason && reason !== 'смена трека') {
        // не засоряем статус на обычной смене трека
      }
    } catch (e) { /* ignore */ }
  }

  /** Локальный файл не подошёл: снимаем привязку, чтобы не ломать трек каждый раз. */
  let lastFailKey = null;
  function failCurrentKey(reason) {
    const key = currentKey;
    if (!key) return;
    // статус ставим ДО всего остального: раньше его затирал sync()
    badge(`локальный файл отклонён: ${reason}`, 'bad');
    if (lastFailKey === key) return;
    lastFailKey = key;

    local.delete(key);
    stopShadow('ошибка файла');
    post({ type: 'diag', payload: { stage: 'файл: отклонён', ok: false, detail: reason, key } });
    // отключаем привязку, чтобы трек больше не ломался при каждом запуске
    request('disableTrack', { key });
  }

  /* ---------- вставки своих треков между треками (0.7.0) ----------

     Состав «Моей волны» решает сервер, туда ничего не добавить. Поэтому вставка
     делается на стыке треков, на стороне страницы:

       1. За INSERT_PREROLL_S секунд до конца трека фон бросает жребий
          (вероятность + минимальный интервал между вставками). Если выпало —
          файл вставки заранее грузится в память («armed»).
       2. Когда трек доиграл и плеер вызывает play() для следующего трека,
          мы этот play() НЕ пропускаем: следующий трек стоит на 0:00,
          а в собственном элементе играет вставка («playing»).
       3. Кнопки плеера управляют вставкой: пауза/играть ставят её на паузу
          и продолжают, ползунок перематывает её, громкость общая.
          «Следующий»/«предыдущий» отменяют вставку и пускают выбранный трек.
       4. Вставка доиграла (или нажали «пропустить» на плашке) — отпускаем
          придержанный трек, волна идёт дальше.

     Вставка срабатывает только на естественном конце трека: если трек
     переключили вручную, жребий сгорает. src элемента плеера по-прежнему
     не трогаем (см. регресс 0.5.0). */

  const INSERT_PREROLL_S = 25;   // за сколько секунд до конца трека решаем
  const INSERT_NEAR_END_S = 3;   // ближе этого к концу — считаем, что трек доигрывает
  // Плавный переход: плеер может запустить следующий трек за несколько секунд до конца
  // текущего. Старт следующего трека в этом окне — всё ещё естественный конец.
  const INSERT_NATURAL_S = 12;
  const INSERT_PREFIX = 'insert:';

  /** { phase: 'arming'|'armed'|'playing', fileId, key, title, artists,
        armedEl, armedSrc, armedAt, nearEnd, heldEl, heldSrc, paused } */
  let insert = null;
  let insertEl = null;
  let insertRolledFor = '';
  let insertAsking = false;
  let insertNote = '';            // строка «вставка: …» на плашке
  let insertForce = false;        // «вставить после этого трека» из попапа
  let insertRetryAt = 0;          // интервал ещё не прошёл — пробуем снова позже в этом же треке

  function note(text, detail) {
    if (insertNote === text) return;
    insertNote = text;
    if (detail) post({ type: 'diag', payload: { stage: 'вставка: ' + text, ok: detail === 'ok', detail: '', key: null } });
    try { badge(status.text, status.tone); } catch (e) { /* ignore */ }
  }

  /* Длительность: у потока плеера duration бывает NaN/Infinity. Тогда берём её
     из navigator.mediaSession.setPositionState, которым плеер кормит ОС. */
  let positionState = null;       // { duration, position, at }
  try {
    const ms = navigator.mediaSession;
    if (ms && typeof ms.setPositionState === 'function') {
      const origSPS = ms.setPositionState.bind(ms);
      ms.setPositionState = function (st) {
        try {
          if (st && isFinite(st.duration) && st.duration > 0) {
            positionState = { duration: st.duration, position: st.position || 0, at: Date.now(), rate: st.playbackRate || 1 };
          }
        } catch (e) { /* ignore */ }
        return origSPS(st);
      };
    }
  } catch (e) { /* ignore */ }

  /** {duration, left} текущего трека или null, если длительность неизвестна. */
  function timing(el) {
    if (el && isFinite(el.duration) && el.duration > 0) {
      return { duration: el.duration, left: el.duration - (el.currentTime || 0), via: 'audio' };
    }
    if (positionState && Date.now() - positionState.at < 15000) {
      const pos = el && el.currentTime > 0 ? el.currentTime
        : positionState.position + (el && el.paused ? 0 : (Date.now() - positionState.at) / 1000 * positionState.rate);
      return { duration: positionState.duration, left: positionState.duration - pos, via: 'mediaSession' };
    }
    return null;
  }

  function isInsertKey(key) { return typeof key === 'string' && key.indexOf(INSERT_PREFIX) === 0; }

  function fire(el, type) {
    try { el.dispatchEvent(new Event(type)); } catch (e) { /* ignore */ }
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    const t = Math.floor(s);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }

  function ensureInsertEl() {
    if (insertEl) return insertEl;
    insertEl = origCreateElement.call(document, 'audio');
    insertEl.__ymuOwn = true;
    insertEl.preload = 'auto';
    media.delete(insertEl);
    insertEl.addEventListener('ended', () => releaseInsert('доиграла', true));
    // прогресс вставки → интерфейс плеера (он слушает события придержанного элемента)
    for (const t of ['timeupdate', 'durationchange', 'seeked']) {
      insertEl.addEventListener(t, () => {
        if (insert && insert.phase === 'playing' && insert.heldEl) fire(insert.heldEl, t);
      });
    }
    insertEl.addEventListener('error', () => {
      if (insert && insert.phase === 'playing') releaseInsert('файл вставки не декодируется', true);
    });
    return insertEl;
  }

  /** Громкость вставки = громкость плеера (с учётом того, что мы его могли заглушить). */
  function mirrorVolume(from, to) {
    if (!from || !to) return;
    const muted = from.__ymuWasMuted !== undefined ? from.__ymuWasMuted : from.muted;
    const vol = muted ? 0 : (typeof from.volume === 'number' ? from.volume : 1);
    if (Math.abs((to.volume ?? 1) - vol) > 0.001) to.volume = vol;
  }

  /* ---------- плеер видит вставку как свой трек ----------
     На время вставки на придержанном элементе (на самом объекте, не на прототипе,
     и не src) ставим геттеры currentTime / duration / paused / ended.
     Интерфейс плеера читает их для ползунка, времени и кнопки «пауза», а запись
     currentTime (перемотка ползунком) уходит во вставку. После вставки геттеры
     снимаются, и элемент снова отдаёт свои настоящие значения. */

  const PROXIED = ['currentTime', 'duration', 'paused', 'ended'];

  function findDesc(obj, name) {
    for (let o = obj; o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, name);
      if (d) return d;
    }
    return null;
  }

  /** Настоящее значение свойства элемента, даже если на нём сейчас наш геттер. */
  function real(el, name) {
    const r = el && el.__ymuReal && el.__ymuReal[name];
    return r ? r.get() : el[name];
  }
  function setReal(el, name, v) {
    const r = el && el.__ymuReal && el.__ymuReal[name];
    if (r) r.set(v); else el[name] = v;
  }

  /** Коэффициент «время трека плеера / время вставки», чтобы ползунок шёл в долях. */
  function insertScale(el) {
    const td = real(el, 'duration');
    const id = insertEl && insertEl.duration;
    return isFinite(td) && td > 0 && isFinite(id) && id > 0 ? td / id : 1;
  }

  function proxyHeld(el) {
    if (!el || el.__ymuReal) return;
    const realMap = {};
    for (const name of PROXIED) {
      const own = Object.getOwnPropertyDescriptor(el, name);
      if (own && 'value' in own) {
        const box = { v: own.value };
        realMap[name] = { own: true, get: () => box.v, set: (v) => { box.v = v; } };
      } else {
        const d = findDesc(Object.getPrototypeOf(el), name);
        realMap[name] = {
          own: false,
          get: () => (d && d.get ? d.get.call(el) : undefined),
          set: (v) => { if (d && d.set) d.set.call(el, v); },
        };
      }
    }
    try { Object.defineProperty(el, '__ymuReal', { value: realMap, configurable: true, writable: true }); }
    catch (e) { return; }

    const def = (name, get, set) => {
      try { Object.defineProperty(el, name, { configurable: true, enumerable: true, get, set }); } catch (e) {}
    };
    def('currentTime',
      () => (insertEl ? (insertEl.currentTime || 0) * insertScale(el) : 0),
      (v) => {
        // ползунок плеера → перемотка вставки
        if (!insertEl) return;
        const t = Math.max(0, Number(v) || 0) / insertScale(el);
        try { insertEl.currentTime = isFinite(insertEl.duration) ? Math.min(t, insertEl.duration - 0.25) : t; } catch (e) {}
        fire(el, 'seeking'); fire(el, 'timeupdate'); fire(el, 'seeked');
      });
    def('duration', () => {
      const td = realMap.duration.get();
      return isFinite(td) && td > 0 ? td : (insertEl ? insertEl.duration : td);
    }, (v) => realMap.duration.set(v));
    def('paused', () => !!(insert && insert.paused), (v) => realMap.paused.set(v));
    def('ended', () => false, (v) => realMap.ended.set(v));
  }

  function unproxyHeld(el) {
    if (!el || !el.__ymuReal) return;
    const realMap = el.__ymuReal;
    for (const name of PROXIED) {
      const r = realMap[name];
      const v = r.get();
      try { delete el[name]; } catch (e) {}
      if (r.own) { try { el[name] = v; } catch (e) {} }   // было собственное поле — возвращаем
    }
    try { delete el.__ymuReal; } catch (e) {}
    fire(el, 'durationchange');
    fire(el, 'timeupdate');
  }

  /* ---------- название, исполнитель и обложка вставки в интерфейсе ---------- */

  const PLACEHOLDER_COVER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b3ea8"/>' +
    '<stop offset="1" stop-color="#1d1f2b"/></linearGradient></defs>' +
    '<rect width="300" height="300" fill="url(#g)"/>' +
    '<path d="M180 70v118a34 34 0 1 1-16-29V102l-60 14v92a34 34 0 1 1-16-29V92z" fill="#fff" opacity=".88"/>' +
    '</svg>');

  const ui = { found: null, saved: [], meta: undefined, metaOurs: null, title: null,
    targets: [], observer: null, warned: false, applying: false };

  const TIME_RE = /^\s*[-−–]?\d{1,2}:\d{2}(?::\d{2})?\s*$/;

  function normText(v) {
    return String(v || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  }

  function textNodes(root) {
    const out = [];
    try {
      const w = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
      for (let n = w.nextNode(); n && out.length < 20000; n = w.nextNode()) {
        if (n.nodeValue && n.nodeValue.trim()) out.push(n);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function rectOf(el) {
    try { return el.getBoundingClientRect(); } catch (e) { return null; }
  }

  function firstText(el) {
    const arr = el ? textNodes(el) : [];
    return arr.length ? arr[0] : null;
  }

  /** Что сейчас показывает плеер (до того как мы подменили метаданные). */
  function rememberTarget(t) {
    if (!t || !t.title) return;
    const key = normText(t.artists) + '|' + normText(t.title);
    if (ui.targets.some((x) => x.key === key)) return;
    ui.targets.unshift({ key, title: t.title, artists: t.artists || '' });
    ui.found = null;            // ищем бар заново под новое название
    ui.lastLocate = 0;
  }

  /* Бар плеера ищем по ТЕКСТУ: узел с названием текущего трека в нижней части
     экрана. Классы сайта меняются, а название трека в баре есть всегда. */
  function locateByText() {
    const H = (typeof innerHeight === 'number' && innerHeight) || 800;
    const all = textNodes(document.body || document.documentElement);
    for (const t of ui.targets) {
      const want = normText(t.title);
      if (!want) continue;
      let best = null;
      for (const n of all) {
        const v = normText(n.nodeValue);
        if (!v) continue;
        // точное совпадение или начало названия (версия трека бывает в соседнем узле)
        const hit = v === want ? 2 : (v.length >= 3 && want.indexOf(v) === 0 ? 1 : 0);
        if (!hit) continue;
        const el = n.parentElement;
        const r = el && rectOf(el);
        if (!r || r.height <= 0 || r.width <= 0) continue;
        if (r.top < H * 0.5) continue;           // бар плеера — внизу экрана
        const score = hit * 10 + r.top / H;
        if (!best || score > best.score) best = { node: n, el, score };
      }
      if (!best) continue;

      // корень бара: ближайший предок, где есть картинка и несколько кнопок
      let root = best.el;
      for (let i = 0, a = best.el; i < 10 && a; i++, a = a.parentElement) {
        root = a;
        let imgs = 0, btns = 0;
        try { imgs = a.querySelectorAll('img').length; btns = a.querySelectorAll('button').length; } catch (e) {}
        if (imgs >= 1 && btns >= 2) break;
      }

      const names = String(t.artists || '').split(/\s*,\s*|\s+&\s+|\s+feat\.?\s+/i).map(normText).filter(Boolean);
      const whole = normText(t.artists);
      const inRoot = textNodes(root);
      const artistNodes = inRoot.filter((n) => n !== best.node &&
        (normText(n.nodeValue) === whole || names.includes(normText(n.nodeValue))));
      const timeNodes = inRoot.filter((n) => TIME_RE.test(n.nodeValue));

      let img = null;
      for (let a = best.el, j = 0; a && j < 8 && !img; j++, a = a.parentElement) {
        try { img = a.querySelector('img'); } catch (e) { img = null; }
      }
      return withBar({ method: 'текст', root, titleNode: best.node, titleEl: best.el, artistNodes, hideEls: [], timeNodes, img });
    }
    return null;
  }

  /** Запасной путь (0.7.2): ссылка на трек, ближе всего к которой кнопки управления. */
  function locateByLinks() {
    const isCtl = (b) => /пауз|воспроизв|играть|следующ|предыдущ|pause|play|next|prev/i
      .test((b.getAttribute && (b.getAttribute('aria-label') || b.getAttribute('title'))) || '');
    let links = [];
    try { links = [...document.querySelectorAll('a[href*="/track/"]')]; } catch (e) { links = []; }
    let best = null;
    for (const link of links) {
      let node = link;
      for (let i = 0; i < 9 && node && node.parentElement; i++) {
        node = node.parentElement;
        if (best && i >= best.level) break;
        let btns = [];
        try { btns = [...node.querySelectorAll('button')]; } catch (e) { btns = []; }
        if (btns.filter(isCtl).length >= 2) { best = { level: i, link, root: node }; break; }
      }
    }
    if (!best) return null;
    let img = null;
    for (let a = best.link, j = 0; a && j < 6 && !img; j++, a = a.parentElement) {
      try { img = a.querySelector('img'); } catch (e) { img = null; }
    }
    let artists = [];
    try { artists = [...best.root.querySelectorAll('a[href*="/artist/"]')]; } catch (e) { artists = []; }
    return withBar({
      method: 'ссылки', root: best.root, titleNode: firstText(best.link), titleEl: best.link,
      artistNodes: artists.slice(0, 1).map(firstText).filter(Boolean), hideEls: artists.slice(1),
      timeNodes: textNodes(best.root).filter((n) => TIME_RE.test(n.nodeValue)), img,
    });
  }

  /* Время у Яндекса лежит не в блоке с названием, а в полосе прогресса того же бара.
     Поднимаемся от названия до бара плеера: элемент с PlayerBar в классе либо первый
     предок внизу экрана, в котором есть метки времени. */
  function withBar(f) {
    if (!f) return f;
    const H = (typeof innerHeight === 'number' && innerHeight) || 800;
    let bar = null, withTimes = null;
    for (let a = f.titleEl || f.root, i = 0; a && i < 14; i++, a = a.parentElement) {
      const r = rectOf(a);
      if (r && r.height > 0 && r.top + r.height < H * 0.5) break;     // ушли выше бара
      if (/PlayerBar/i.test(String(a.className || ''))) bar = a;      // самый внешний PlayerBar
      if (!withTimes) {
        const times = textNodes(a).filter((n) => TIME_RE.test(n.nodeValue));
        if (times.length >= 2) withTimes = a;
      }
    }
    f.barRoot = bar || withTimes || f.root;
    findTimes(f);
    return f;
  }

  function findTimes(f) {
    const all = textNodes(f.barRoot).filter((n) => TIME_RE.test(n.nodeValue));
    f.timeNodes = all.length ? all.slice(0, 2) : f.timeNodes;
    f.timesFoundAt = Date.now();
  }

  /** Секунды из «02:37», «-1:05», «1:02:03». */
  function parseTime(v) {
    const m = String(v || '').trim().replace(/^[-−–]/, '').split(':').map(Number);
    if (m.some((x) => !isFinite(x))) return NaN;
    return m.reduce((acc, x) => acc * 60 + x, 0);
  }

  /** Время в том же виде, что у плеера: «02:37», если он пишет минуты двумя цифрами. */
  function fmtLike(sec, sample) {
    const t = Math.max(0, Math.floor(isFinite(sec) ? sec : 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const pad2 = /^\s*[-−–]?\d{2}:/.test(sample || '');
    const mm = h ? String(m).padStart(2, '0') : (pad2 ? String(m).padStart(2, '0') : String(m));
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  function barAlive(f) {
    return f && f.root && f.root.isConnected !== false && f.titleNode &&
      (!f.titleEl || f.titleEl.isConnected !== false);
  }

  /** Подменяем значение узла, запомнив исходное. Узлы не пересоздаём — их держит React. */
  function swap(node, prop, value) {
    if (!node) return;
    let rec = ui.saved.find((r) => r.node === node && r.prop === prop);
    if (!rec) { rec = { node, prop, orig: prop === 'display' ? node.style.display : node[prop] }; ui.saved.push(rec); }
    if (prop === 'display') { if (node.style.display !== value) node.style.display = value; }
    else if (node[prop] !== value) node[prop] = value;
  }

  function applyInsertUi() {
    if (!insert || insert.phase !== 'playing' || ui.applying) return;
    ui.applying = true;
    try {
      const title = insert.title || 'Свой трек';
      const artists = insert.artists || 'YM Uncensored';
      const cover = insert.cover || PLACEHOLDER_COVER;
      const ms = navigator.mediaSession;

      // плеер поменял метаданные — значит, это его трек: запоминаем, чтобы найти в баре
      try {
        const md = ms && ms.metadata;
        if (md && md !== ui.metaOurs && md.title) rememberTarget({ title: md.title, artists: md.artist || '' });
      } catch (e) { /* ignore */ }

      if (!barAlive(ui.found) && Date.now() - (ui.lastLocate || 0) > 1500) {
        ui.lastLocate = Date.now();        // поиск обходит весь DOM — не чаще раза в 1.5 с
        ui.found = locateByText() || locateByLinks();
        if (ui.observer) { try { ui.observer.disconnect(); } catch (e) {} ui.observer = null; }
        if (ui.found && typeof MutationObserver === 'function') {
          // React вернёт своё значение — сразу ставим наше обратно, до отрисовки
          try {
            ui.observer = new MutationObserver(() => applyInsertUi());
            ui.observer.observe(ui.found.barRoot || ui.found.root, { subtree: true, characterData: true, childList: true,
              attributes: true, attributeFilter: ['src', 'srcset'] });
          } catch (e) { ui.observer = null; }
        }
        if (!ui.found && !ui.warned) {
          ui.warned = true;
          post({ type: 'diag', payload: { stage: 'вставка: бар плеера не найден', ok: false,
            detail: 'искал: ' + ui.targets.map((t) => t.title).join(' / '), key: null } });
        }
      }

      const f = ui.found;
      if (f) {
        swap(f.titleNode, 'nodeValue', title);
        if (f.titleEl) swap(f.titleEl, 'title', title);
        f.artistNodes.forEach((n, i) => swap(n, 'nodeValue', i === 0 ? artists : ''));
        f.hideEls.forEach((el) => swap(el, 'display', 'none'));
        if (f.img) { swap(f.img, 'srcset', ''); swap(f.img, 'src', cover); }

        // время на ползунке: React мог пересоздать узлы — ищем заново
        if (f.timeNodes.some((n) => n.isConnected === false) && Date.now() - (f.timesFoundAt || 0) > 500) findTimes(f);
        if (insertEl && f.timeNodes.length && insert.heldEl) {
          const cur = insertEl.currentTime || 0, dur = insertEl.duration;
          // какая из меток — длина: та, что совпадает с длиной придержанного трека
          const heldDur = real(insert.heldEl, 'duration');
          const origOf = (n) => (ui.saved.find((r) => r.node === n && r.prop === 'nodeValue') || {}).orig ?? n.nodeValue;
          let totalIdx = f.timeNodes.findIndex((n) => isFinite(heldDur) && Math.abs(parseTime(origOf(n)) - heldDur) <= 1.5);
          if (totalIdx < 0) totalIdx = f.timeNodes.length > 1 ? 1 : -1;
          f.timeNodes.forEach((n, i) => {
            const orig = origOf(n);
            const minus = /^\s*[-−–]/.test(orig);
            let v;
            if (minus) v = '-' + fmtLike((dur || 0) - cur, orig);
            else if (i === totalIdx) v = fmtLike(dur, orig);
            else v = fmtLike(cur, orig);
            swap(n, 'nodeValue', v);
          });
        }
      }

      // системная плашка ОС и Chrome
      try {
        if (ms && typeof MediaMetadata === 'function') {
          if (ui.meta === undefined) ui.meta = ms.metadata;
          if (!ui.metaOurs) {
            ui.metaOurs = new MediaMetadata({ title, artist: artists, album: 'YM Uncensored',
              artwork: [{ src: cover, sizes: '300x300', type: insert.cover ? 'image/jpeg' : 'image/svg+xml' }] });
          }
          if (ms.metadata !== ui.metaOurs) ms.metadata = ui.metaOurs;
        }
      } catch (e) { /* ignore */ }

      // заголовок вкладки
      try {
        const want = `${title} — ${artists}`;
        if (ui.title === null) ui.title = document.title;
        if (document.title !== want) document.title = want;
      } catch (e) { /* ignore */ }
    } finally {
      ui.applying = false;
    }
  }

  function restoreInsertUi() {
    if (ui.observer) { try { ui.observer.disconnect(); } catch (e) {} }
    for (const r of ui.saved.reverse()) {
      try {
        if (r.prop === 'display') r.node.style.display = r.orig;
        else if (r.node[r.prop] !== r.orig) r.node[r.prop] = r.orig;
      } catch (e) { /* ignore */ }
    }
    try {
      const ms = navigator.mediaSession;
      if (ms && ui.meta !== undefined && ms.metadata === ui.metaOurs) ms.metadata = ui.meta;
    } catch (e) { /* ignore */ }
    try { if (ui.title !== null) document.title = ui.title; } catch (e) { /* ignore */ }
    ui.found = null; ui.saved = []; ui.meta = undefined; ui.metaOurs = null; ui.title = null;
    ui.targets = []; ui.observer = null; ui.warned = false; ui.lastLocate = 0;
  }

  /* ---------- отчёт для отладки (кнопка в попапе) ---------- */

  function elPath(el) {
    const out = [];
    for (let a = el, i = 0; a && a.tagName && i < 5; i++, a = a.parentElement) {
      const tid = a.getAttribute && (a.getAttribute('data-test-id') || a.getAttribute('data-testid'));
      const cls = String(a.className || '').split(/\s+/).filter(Boolean)[0];
      out.push(a.tagName.toLowerCase() + (tid ? `[${tid}]` : cls ? '.' + cls.slice(0, 40) : ''));
    }
    return out.join(' < ');
  }

  function probeBar() {
    const H = (typeof innerHeight === 'number' && innerHeight) || 0;
    const info = collectInfo();
    const savedTargets = ui.targets.slice();
    if (!ui.targets.length && info) rememberTarget(info);
    let found = null;
    try { found = locateByText() || locateByLinks(); } catch (e) { found = null; }
    if (!insert) ui.targets = savedTargets;

    const bottom = [];
    for (const n of textNodes(document.body || document.documentElement)) {
      const el = n.parentElement, r = el && rectOf(el);
      if (!r || r.height <= 0 || r.top < H * 0.75) continue;
      bottom.push(`${n.nodeValue.trim().slice(0, 40)}  ⟵ ${elPath(el)}`);
      if (bottom.length >= 40) break;
    }
    const buttons = [];
    try {
      for (const b of document.querySelectorAll('button')) {
        const r = rectOf(b);
        if (!r || r.top < H * 0.75) continue;
        buttons.push((b.getAttribute('aria-label') || b.getAttribute('title') || '(без подписи)') + ' ⟵ ' + elPath(b));
        if (buttons.length >= 20) break;
      }
    } catch (e) { /* ignore */ }

    return {
      at: new Date().toISOString(), viewport: H,
      track: info, insert: insert ? { phase: insert.phase, title: insert.title } : null, insertNote,
      mediaCount: media.size,
      bar: found ? {
        method: found.method, root: elPath(found.root), title: found.titleNode && found.titleNode.nodeValue,
        artists: found.artistNodes.length, times: found.timeNodes.map((n) => n.nodeValue), cover: !!found.img,
      } : null,
      trackLinks: (() => { try { return document.querySelectorAll('a[href*="/track/"]').length; } catch (e) { return -1; } })(),
      bottomTexts: bottom, bottomButtons: buttons,
    };
  }

  function insertLabel() {
    if (!insert) return '';
    return insert.artists ? `${insert.artists} — ${insert.title}` : (insert.title || 'свой трек');
  }

  function renderInsertBadge() {
    if (!insert || insert.phase !== 'playing') return;
    const a = insertEl;
    const pos = a ? `${fmtTime(a.currentTime)} / ${fmtTime(a.duration)}` : '';
    badge(`вставка · ${insertLabel()} · ${pos}${insert.paused ? ' · пауза' : ''}`, 'insert',
      { label: '⏭ пропустить', fn: () => releaseInsert('пропущена', true) });
  }

  function dropInsertFile(ins) {
    if (!ins || !ins.key) return;
    const rec = local.get(ins.key);
    if (rec && rec.url) { try { URL.revokeObjectURL(rec.url); } catch (e) {} }
    local.delete(ins.key);
  }

  /** Сбросить подготовленную вставку, которая так и не заиграла. */
  function disarm(reason) {
    const ins = insert;
    if (!ins || ins.phase === 'playing') return;
    insert = null;
    dropInsertFile(ins);
    insertNote = '';
    note('сгорела: ' + (reason || '?'), 'bad');
  }

  /** Конец вставки. resumePlayer=true — запускаем придержанный трек. */
  function releaseInsert(reason, resumePlayer) {
    const ins = insert;
    if (!ins || ins.phase !== 'playing') return;
    insert = null;
    if (insertEl) {
      try { insertEl.pause(); } catch (e) {}
      try { insertEl.removeAttribute('src'); insertEl.load(); } catch (e) {}
    }
    dropInsertFile(ins);
    unproxyHeld(ins.heldEl);
    restoreInsertUi();
    insertNote = '';
    note(reason === 'доиграла' ? 'доиграла, ждём следующую' : (reason || 'завершена'));
    badge(`вставка ${reason || 'завершена'} · волна продолжается`, 'idle');
    const h = ins.heldEl;
    if (resumePlayer && h && h.src === ins.heldSrc) {
      try { h.currentTime = 0; } catch (e) {}       // трек начинается с начала
      try {
        const p = origPlay.call(h);
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* ignore */ }
    }
  }

  function startInsert(el) {
    const rec = local.get(insert.key);
    if (!rec) { disarm('файл вставки не загрузился'); return null; }

    const a = ensureInsertEl();
    if (a.canPlayType && String(a.canPlayType(rec.mime || 'audio/mpeg')) === '') {
      disarm(`формат вставки не поддерживается: ${rec.mime}`);
      return null;
    }

    insert.phase = 'playing';
    insert.heldEl = el;
    insert.heldSrc = el.src;
    insert.paused = false;

    a.src = rec.url;
    try { a.load(); } catch (e) {}
    mirrorVolume(el, a);
    try { if (!el.paused) origPause.call(el); } catch (e) {}
    // при плавном переходе предыдущий трек ещё доигрывает — глушим его хвост
    const prev = insert.armedEl;
    if (prev && prev !== el && !prev.paused) { try { origPause.call(prev); } catch (e) {} }
    insertNote = '';

    const p = origPlay.call(a);
    if (p && p.catch) {
      p.catch((err) => {
        badge(`вставка не запустилась: ${(err && err.name) || 'ошибка'}`, 'bad');
        releaseInsert('не запустилась', true);
      });
    }

    request('insertStarted', { fileId: insert.fileId });
    post({ type: 'diag', payload: { stage: 'вставка: играет', ok: true, detail: insertLabel(), key: null } });
    proxyHeld(el);
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (lastInfo) rememberTarget(lastInfo);
      if (md && md.title) rememberTarget({ title: md.title, artists: md.artist || '' });   // новее — первым
    } catch (e) { /* ignore */ }
    applyInsertUi();
    // интерфейс плеера считает, что следующий трек запущен
    setTimeout(() => { fire(el, 'durationchange'); fire(el, 'play'); fire(el, 'playing'); fire(el, 'timeupdate'); }, 0);
    renderInsertBadge();
    return Promise.resolve();
  }

  /** Перехват play() элемента плеера. Возвращает промис, если вызов поглощён вставкой. */
  function insertOnPlay(el) {
    if (!insert) return null;

    if (insert.phase === 'playing') {
      if (el !== insert.heldEl || el.src !== insert.heldSrc) {
        // «следующий»/«предыдущий» или выбор другого трека: отдаём управление плееру
        releaseInsert('отменена: переключили трек', false);
        return null;
      }
      // кнопка «играть» плеера → продолжаем вставку
      if (insert.paused) {
        insert.paused = false;
        const p = origPlay.call(insertEl);
        if (p && p.catch) p.catch(() => {});
      }
      setTimeout(() => { fire(el, 'play'); fire(el, 'playing'); }, 0);
      renderInsertBadge();
      return Promise.resolve();
    }

    // подготовленная вставка: ждём старта именно СЛЕДУЮЩЕГО трека
    const nextTrack = el !== insert.armedEl || el.src !== insert.armedSrc;
    if (!nextTrack) return null;            // продолжение того же трека после паузы
    const left = armedLeft();
    const natural = insert.nearEnd || (left !== null && left <= INSERT_NATURAL_S);
    if (insert.phase === 'armed' && (natural || settings.insertOnSkip)) return startInsert(el);
    if (insert.phase !== 'armed') disarm('файл вставки не успел загрузиться');
    else disarm(`трек переключили вручную (за ${left === null ? '?' : Math.round(left)} с до конца), а вставки при переключении выключены`);
    return null;
  }

  /** Перехват pause() элемента плеера: во время вставки ставим на паузу её. */
  function insertOnPause(el) {
    if (!insert || insert.phase !== 'playing' || el !== insert.heldEl) return;
    if (!insert.paused) {
      insert.paused = true;
      try { insertEl.pause(); } catch (e) {}
    }
    // сам элемент уже на паузе и события не пошлёт — шлём за него
    setTimeout(() => fire(el, 'pause'), 0);
    renderInsertBadge();
  }

  /** Сколько секунд оставалось подготовленному треку (живое значение или последнее известное). */
  function armedLeft() {
    if (!insert) return null;
    const a = insert.armedEl;
    if (a && a.src === insert.armedSrc) {
      if (a.ended) return 0;
      const t = timing(a);
      if (t) return t.left;
    }
    if (typeof insert.lastLeft === 'number') {
      return insert.lastLeft - (Date.now() - insert.lastLeftAt) / 1000;
    }
    return null;
  }

  /** Попап: «вставить после этого трека» — без жребия и интервала. */
  function forceInsert() {
    insertForce = true;
    insertRolledFor = '';
    if (insert && insert.phase !== 'playing') disarm('заменена принудительной');
    note('будет после этого трека (принудительно)', 'ok');
    maybeArm();
  }

  function onPlayerEnded(el) {
    if (insert && insert.phase !== 'playing' && el === insert.armedEl) insert.nearEnd = true;
  }

  /** Бросаем жребий ближе к концу трека, чтобы файл успел загрузиться. */
  function maybeArm() {
    if (!settings.enabled || !settings.insertEnabled) { insertNote = ''; return; }
    if (insertAsking) return;
    const p = playerMedia();
    if (!p) { note('плеер не найден — включи воспроизведение'); return; }
    if (p.paused) return;
    const t = timing(p);
    if (!t) { note('длительность трека неизвестна — не знаю, когда конец'); return; }

    // Вставка на ручном переключении: жребий бросаем сразу в начале трека, чтобы файл
    // уже лежал в памяти, когда нажмут «следующий». Иначе — за 25 с до конца.
    if (!insertForce) {
      if (!settings.insertOnSkip && t.left > INSERT_PREROLL_S) {
        note(`жребий за ${INSERT_PREROLL_S} с до конца трека (осталось ${Math.round(t.left)} с)`);
        return;
      }
      if (t.left < INSERT_NEAR_END_S + 1) return;
    }

    const tag = String(p.src) + '|' + Math.round(t.duration);
    if (insertRolledFor === tag && !(insertRetryAt && Date.now() >= insertRetryAt)) return;   // один жребий на трек
    insertRolledFor = tag;
    insertRetryAt = 0;
    insertAsking = true;
    const forced = insertForce;
    insertForce = false;

    request('pickInsert', { force: forced }).then((res) => {
      insertAsking = false;
      if (!res || !res.ok) { note('фон не ответил на жребий', 'bad'); return; }
      if (!res.fileId) {
        // интервал истечёт посреди трека — бросим жребий ещё раз, а не ждём следующего трека
        if (res.retryInMs > 0 && insertRolledFor === tag) insertRetryAt = Date.now() + Math.min(res.retryInMs + 500, 60000);
        note(res.reason || 'не выпало', 'info');
        return;
      }
      if (insert) return;
      if (String(p.src) !== String(tag.split('|')[0])) { note('трек сменился, пока бросали жребий'); return; }
      const key = INSERT_PREFIX + res.fileId + ':' + Date.now();        // свой ключ на каждую вставку
      insert = {
        phase: 'arming', fileId: res.fileId, key,
        title: res.title || '', artists: res.artists || '', cover: res.cover || null,
        armedEl: p, armedSrc: p.src, armedAt: Date.now(), nearEnd: false,
        lastLeft: t.left, lastLeftAt: Date.now(),
      };
      note(`выпала «${insertLabel()}», загружаю`);
      request('needAudio', { key, fileId: res.fileId });
    });
  }

  /** Плеер запустил следующий трек, а наш перехват play() этого не увидел. */
  function nextStartedWithoutPlay() {
    for (const [el] of media) {
      if (el.__ymuOwn || el.paused) continue;
      if (el !== insert.armedEl || el.src !== insert.armedSrc) return el;
    }
    return null;
  }

  function insertTick() {
    if (!insert) { maybeArm(); return; }

    if (insert.phase !== 'playing') {
      if (!settings.enabled || !settings.insertEnabled) { disarm('вставки выключены'); return; }
      if (insert.phase === 'arming' && local.has(insert.key)) {
        insert.phase = 'armed';
        note(`«${insertLabel()}» сыграет перед следующим треком`, 'ok');
      }
      const a = insert.armedEl;
      if (a && a.src === insert.armedSrc) {
        const t = a.ended ? { left: 0 } : timing(a);
        if (t) {
          insert.lastLeft = t.left;
          insert.lastLeftAt = Date.now();
          if (t.left <= INSERT_NEAR_END_S) insert.nearEnd = true;
        }
      }
      // запасной путь: следующий трек заиграл, а play() мы не поймали
      if (insert.phase === 'armed') {
        const other = nextStartedWithoutPlay();
        if (other) {
          const left = armedLeft();
          if (insert.nearEnd || (left !== null && left <= INSERT_NATURAL_S) || settings.insertOnSkip) { startInsert(other); return; }
          disarm(`трек переключили вручную (за ${left === null ? '?' : Math.round(left)} с до конца), а вставки при переключении выключены`);
          return;
        }
      }
      if (Date.now() - insert.armedAt > 30 * 60 * 1000) disarm('устарела');
      return;
    }

    const h = insert.heldEl;
    if (!h || h.src !== insert.heldSrc) { releaseInsert('отменена: переключили трек', false); return; }

    // перемотка ползунком идёт через геттер currentTime (proxyHeld); если геттер
    // поставить не удалось, ловим сдвиг настоящей позиции и переносим его во вставку
    if (!h.__ymuReal && (h.currentTime || 0) > 0.75 && isFinite(h.duration) && h.duration > 0 &&
        insertEl && isFinite(insertEl.duration) && insertEl.duration > 0) {
      const frac = Math.min(0.99, h.currentTime / h.duration);
      try { insertEl.currentTime = frac * insertEl.duration; } catch (e) {}
      try { h.currentTime = 0; } catch (e) {}
    }

    mirrorVolume(h, insertEl);
    // плеер не должен заиграть поверх вставки
    if (!real(h, 'paused')) { try { origPause.call(h); } catch (e) {} }
    applyInsertUi();
    renderInsertBadge();
  }

  /* ---------- перехват сети: захват и уточнение длительности ---------- */

  function safeStringify(o) {
    try { return JSON.stringify(o); } catch (e) { return ''; }
  }

  function scanJson(data, url) {
    if (!data || typeof data !== 'object') return;

    if (settings.capture) {
      try {
        const s = safeStringify(data);
        const re = /https?:\/\/[^\s"'\\]+(?:get-mp3|get-file-info|download-info|storage\.music|music-v2\/crypt)[^\s"'\\]*/gi;
        let m, n = 0;
        while ((m = re.exec(s)) && n++ < 20) {
          post({ type: 'capture', payload: { kind: 'audioUrl', url: m[0], src: url } });
        }
        post({ type: 'capture', payload: { kind: 'shape', src: url, sample: s.slice(0, 1200) } });
      } catch (e) { /* ignore */ }
    }

    let visited = 0;
    const stack = [data];
    while (stack.length && visited < 2000) {
      const node = stack.pop();
      visited++;
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) { for (const v of node) stack.push(v); continue; }

      if (node.title && node.durationMs) {
        const artists = Array.isArray(node.artists)
          ? node.artists.map((a) => (a && (a.name || a)) || '').join(' ').trim()
          : (node.artists || '');
        if (settings.capture && node.id) {
          post({ type: 'capture', payload: {
            kind: 'track', id: String(node.id), title: node.title, artists,
            durationMs: node.durationMs,
            explicit: !!(node.contentWarning === 'explicit' || node.explicit),
          } });
        }
      }

      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (input) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/music\.yandex|api\.music/.test(url)) {
        p.then((res) => {
          if (!(res.headers.get('content-type') || '').includes('json')) return;
          res.clone().json().then((d) => scanJson(d, url)).catch(() => {});
        }).catch(() => {});
      }
    } catch (e) { /* ignore */ }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) {
    this.__ymuUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        const url = this.__ymuUrl || '';
        if (!/music\.yandex|api\.music/.test(url)) return;
        if (!(this.getResponseHeader('content-type') || '').includes('json')) return;
        const d = this.responseType === 'json' ? this.response
          : (typeof this.responseText === 'string' ? JSON.parse(this.responseText) : null);
        if (d) scanJson(d, url);
      } catch (e) { /* ignore */ }
    });
    return origSend.apply(this, arguments);
  };

  /* ---------- старт ---------- */

  scanDom();
  pollTrack();

  setInterval(() => {
    try {
      for (const [id, t] of transfers) {
        if (Date.now() - (t.lastAt || t.startedAt || 0) > 12000) {
          transfers.delete(id);
          badge('фон не отдаёт файл — пробую снова', 'bad');
          if (t.key && currentKey === t.key) lastSignature = '';
        }
      }
      scanDom();
      pollTrack();
      sync();
      insertTick();
    } catch (e) { /* один сбой не должен останавливать цикл */ }
  }, 400);

  /* ---------- отладка ---------- */

  window.__ymuState = () => {
    const player = playerMedia();
    const sh = shadow && shadow.el;
    return {
      keys: [...local.keys()],
      currentKey,
      status,
      mediaCount: media.size,
      player: player ? {
        src: String(player.src || '').slice(0, 60),
        paused: player.paused,
        muted: player.muted,
        currentTime: player.currentTime,
        volume: player.volume,
        error: player.error ? player.error.code : null,
      } : null,
      shadow: sh ? {
        src: String(sh.src || '').slice(0, 60),
        paused: sh.paused,
        currentTime: sh.currentTime,
        volume: sh.volume,
        readyState: sh.readyState,
        error: sh.error ? sh.error.code : null,
      } : null,
      insertNote,
      insert: insert ? {
        phase: insert.phase, fileId: insert.fileId, key: insert.key,
        nearEnd: !!insert.nearEnd, paused: !!insert.paused,
      } : null,
      insertEl: insertEl ? {
        src: String(insertEl.src || '').slice(0, 60),
        paused: insertEl.paused,
        currentTime: insertEl.currentTime,
        volume: insertEl.volume,
      } : null,
    };
  };
  window.__ymuForcePoll = () => { lastSignature = ''; };
  window.__ymuMedia = () => [...media.keys()];

  try { console.info('[YMU] готов, режим параллельного воспроизведения'); } catch (e) {}
})();

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

  const settings = { enabled: true, badge: true, capture: false };
  const local = new Map();       // key -> {url, size, mime}
  const transfers = new Map();   // transferId -> {key, parts, mime, lastAt}
  const pending = new Map();     // reqId -> callback

  /** Медиаэлементы самого плеера. Наши собственные сюда не попадают. */
  const media = new Map();       // element -> {firstSeen, playing}

  let currentKey = null;
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

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function badge(text, tone) {
    status = { text, tone: tone || 'idle' };
    if (!settings.badge) { if (badgeEl && badgeEl.style) badgeEl.style.display = 'none'; return; }
    try {
      if (!badgeEl || !badgeEl.isConnected) {
        badgeEl = document.createElement('div');
        badgeEl.id = 'ymu-badge';
        badgeEl.style.cssText = [
          'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483647',
          'padding:5px 9px', 'border-radius:7px',
          'font:11px/1.35 -apple-system,Segoe UI,Roboto,sans-serif',
          'background:rgba(20,21,26,.92)', 'color:#cfd3de',
          'border:1px solid #3a3f4f', 'pointer-events:none',
          'max-width:360px', 'white-space:normal',
        ].join(';');
        (document.body || document.documentElement).appendChild(badgeEl);
      }
      badgeEl.style.display = 'block';
      const colors = { ok: '#7ee27e', warn: '#e8c47a', bad: '#ff8f8f', idle: '#8b8f9c' };
      badgeEl.innerHTML = `<b style="color:${colors[tone] || colors.idle}">YMU</b> ${escapeHtml(text)}`;
    } catch (e) { /* ignore */ }
  }

  /* ---------- реестр элементов плеера ---------- */

  const MEDIA_TAGS = { AUDIO: 1, VIDEO: 1 };
  const origCreateElement = Document.prototype.createElement;
  const origPlay = HTMLMediaElement.prototype.play;

  function isMedia(el) {
    return el && MEDIA_TAGS[el.tagName] === 1;
  }

  function remember(el) {
    if (!isMedia(el) || el.__ymuOwn || media.has(el)) return;
    media.set(el, { firstSeen: Date.now(), playing: false });
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
        }
      } catch (e) { /* ignore */ }
      return origPlay.apply(this, arguments);
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
        }
        break;

      case 'audioStart':
        transfers.set(msg.data.transferId, {
          key: msg.data.key, parts: [], mime: msg.data.mime,
          total: msg.data.size || 0, startedAt: Date.now(), lastAt: Date.now(),
        });
        badge('получаю файл… 0%', 'idle');
        break;

      case 'audioProgress': {
        const tp = transfers.get(msg.data.transferId);
        if (tp) tp.lastAt = Date.now();
        badge(`получаю файл… ${msg.data.percent}%`, 'idle');
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
    const info = collectInfo();
    if (!info || !info.title) {
      if (lastSignature !== '__none__') {
        lastSignature = '__none__';
        currentKey = null;
        badge('трек не определён — включи воспроизведение', 'warn');
      }
      return;
    }

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
    };
  };
  window.__ymuForcePoll = () => { lastSignature = ''; };
  window.__ymuMedia = () => [...media.keys()];

  try { console.info('[YMU] готов, режим параллельного воспроизведения'); } catch (e) {}
})();

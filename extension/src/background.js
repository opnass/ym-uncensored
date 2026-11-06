/* background.js — service worker: единственный владелец нормализации и матчинга.
   Страница присылает сырые title/artists и получает готовый ответ
   { ok, key, fileId, enabled, reason }. */
'use strict';

importScripts('normalize.js', 'db.js', 'cover.js', 'importer.js');

const DEFAULTS = {
  enabled: true,
  mode: 'always',
  autoMatch: true,
  fuzzy: true,
  threshold: 0.82,
  // когда артист не определён, сравниваем только названия — но строже
  titleOnlyThreshold: 0.90,
  capture: false,
  badge: true,
  // вставки своих треков между треками (0.7.0)
  insertEnabled: false,
  insertChance: 0.2,       // вероятность вставки на стыке треков, 0..1
  insertMinGapMin: 15,     // не чаще, чем раз в N минут
  insertOnSkip: true,      // вставка и при ручном переключении трека
  autoImport: true,        // подхватывать только что скачанные аудиофайлы (нужна выбранная папка)
};

const CHUNK = 512 * 1024;
const DIAG_LIMIT = 60;

function safeKey(title, artists) {
  try {
    return YMU.trackKey(title, artists);
  } catch (e) {
    return String(artists || '').toLowerCase() + '|' + String(title || '').toLowerCase();
  }
}

async function settings() {
  try {
    return Object.assign({}, DEFAULTS, await YMUDB.allSettings());
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

async function diag(stage, ok, detail, key) {
  try {
    const arr = (await YMUDB.getSetting('diag', [])) || [];
    arr.unshift({ ts: Date.now(), stage, ok: !!ok, detail: detail || '', key: key || null });
    await YMUDB.setSetting('diag', arr.slice(0, DIAG_LIMIT));
  } catch (e) { /* диагностика не должна ломать логику */ }
}

/* ---------- матчинг ---------- */

/* Файлы, импортированные до 0.9.1, знали исполнителя только из имени — а у имён вроде
   «Мукка Таблетка.mp3» его нет. Один раз перечитываем теги и обновляем ключ. */
let metaUpgraded = false;
async function upgradeMeta(files) {
  if (metaUpgraded) return files;
  let changed = false;
  for (const f of files) {
    if (f.metaChecked === 2 || !f.blob) continue;
    try {
      const meta = await YMUImport.metaOf(new File([asBlob(f)], f.name, { type: f.mime || 'audio/mpeg' }));
      const upd = Object.assign({}, f, {
        title: meta.title, artists: meta.artists, key: safeKey(meta.title, meta.artists),
        nameTitle: meta.nameTitle, nameArtists: meta.nameArtists, fromTags: meta.fromTags, metaChecked: 2,
      });
      await YMUDB.putFile(upd);
      Object.assign(f, upd);
      changed = true;
      if (f.key !== safeKey(meta.nameTitle, meta.nameArtists)) {
        await diag('библиотека: теги', true, `${f.name} → ${meta.artists || '?'} — ${meta.title}`);
      }
    } catch (e) { /* файл без тегов или битый — оставляем как есть */ }
  }
  metaUpgraded = true;
  return files;
}

async function findMatch(track, cfg) {
  let files = [];
  try { files = await YMUDB.allFiles(); } catch (e) { files = []; }
  if (!files.length) return { file: null, reason: 'библиотека пуста' };
  files = await upgradeMeta(files);

  const key = safeKey(track.title, track.artists);
  const exact = files.filter((f) => f.key === key);
  if (exact.length) {
    if (exact.length === 1) return { file: exact[0], reason: 'точный ключ' };
    const sorted = exact.slice().sort((a, b) =>
      Math.abs((a.durationMs || 0) - (track.durationMs || 0)) -
      Math.abs((b.durationMs || 0) - (track.durationMs || 0)));
    return { file: sorted[0], reason: 'точный ключ, ближайшая длительность' };
  }

  if (!cfg.fuzzy) return { file: null, reason: 'ключ не совпал, нечёткий поиск выключен' };

  const noArtist = !track.artists;

  let best = null, bestScore = 0;
  const scored = [];

  for (const f of files) {
    let s = 0;
    try {
      if (noArtist) {
        // артист неизвестен: сравниваем только названия, иначе 0.62 не дотянет
        // до общего порога, хотя трек тот самый
        s = YMU.dice(YMU.norm(f.title), YMU.norm(track.title));
        if (f.durationMs && track.durationMs) {
          const diff = Math.abs(f.durationMs - track.durationMs) / 1000;
          if (diff <= 5) s += 0.05;
          else if (diff > 45) s -= 0.30;
        }
        s = Math.max(0, Math.min(1, s));
      } else {
        const cand = { title: f.title, artists: f.artists, durationMs: f.durationMs };
        const target = { title: track.title, artists: track.artists, durationMs: track.durationMs };
        s = YMU.score(cand, target);
        // исполнитель не отделён от названия («Мукка Таблетка») — сравниваем строку целиком
        if (!f.artists) s = Math.max(s, YMU.scoreLoose(cand, target));
      }
    } catch (e) { s = 0; }
    scored.push([s, f]);
    if (s > bestScore) { bestScore = s; best = f; }
  }

  scored.sort((a, b) => b[0] - a[0]);
  const top = scored.slice(0, 3).map(([s, f]) => `${f.name || f.title}=${s.toFixed(2)}`).join(', ');
  const threshold = noArtist ? cfg.titleOnlyThreshold : cfg.threshold;

  // при матче по одному титулу нужен явный отрыв от второго места:
  // «Таблетка» и «Таблетка (Live)» не должны путаться
  if (noArtist && scored.length > 1) {
    const gap = scored[0][0] - scored[1][0];
    if (gap < 0.12) {
      return {
        file: null,
        reason: `артист не определён, а два файла похожи (разрыв ${gap.toFixed(2)})` + (top ? ` (${top})` : ''),
      };
    }
  }

  if (best && bestScore >= threshold) {
    return {
      file: Object.assign({}, best, { __score: bestScore }),
      reason: noArtist ? `по названию ${bestScore.toFixed(2)}` : `нечёткий ${bestScore.toFixed(2)}`,
    };
  }

  return {
    file: null,
    reason: `лучший ${bestScore.toFixed(2)} < порога ${threshold}`
      + (noArtist ? ' (артист не определён)' : '')
      + (top ? ` (${top})` : ''),
  };
}

/* ---------- треки без файла ---------- */

const MISSING_LIMIT = 200;

/** Трек играл, а локального файла для него нет — запоминаем для списка «Треки без файла».
    Только определённые через Media Session: запасные пути по DOM иногда хватают
    случайную ссылку или заголовок вкладки, и такие «треки» засоряли бы список. */
async function noteMissing(key, title, artists, via) {
  if (!/mediaSession/.test(via || '') || !title) return;
  try {
    const list = (await YMUDB.getSetting('missing', [])) || [];
    const i = list.findIndex((m) => m.key === key);
    const now = Date.now();
    if (i >= 0) {
      list[i].count = (list[i].count || 1) + 1;
      list[i].lastSeen = now;
    } else {
      list.push({ key, title, artists: artists || '', count: 1, firstSeen: now, lastSeen: now, hidden: false });
    }
    list.sort((a, b) => b.lastSeen - a.lastSeen);
    await YMUDB.setSetting('missing', list.slice(0, MISSING_LIMIT));
  } catch (e) { /* список — подсказка, ошибки не важны */ }
}

/* ---------- главная точка ---------- */

async function resolveTrack(p) {
  const title = (p.title || '').trim();
  const artists = (p.artists || '').trim();
  if (!title) return { ok: false, error: 'пустое название трека' };

  const key = safeKey(title, artists);
  const cfg = await settings();

  try {
    await YMUDB.setSetting('lastTrack', {
      title, artists, key,
      durationMs: p.durationMs || 0,
      via: p.via || '',
      ts: Date.now(),
    });
  } catch (e) { /* ignore */ }

  if (!cfg.enabled) {
    await diag('трек: определён', true, `«${artists || '?'} — ${title}», расширение выключено`, key);
    return { ok: true, key, fileId: null, enabled: false, reason: 'расширение выключено' };
  }

  await diag('трек: определён', true,
    `«${artists || 'артист не определён'} — ${title}» через ${p.via || '?'}`, key);

  let binding = null;
  try { binding = await YMUDB.getBinding(key); } catch (e) { binding = null; }

  if (binding) {
    if (binding.disabled) {
      await diag('матч: трек отключён', false, 'вручную выключено для этого трека', key);
      return { ok: true, key, fileId: null, enabled: true, reason: 'трек отключён вручную' };
    }
    if (binding.fileId) {
      await diag('матч: есть привязка', true, `${binding.mode}, файл ${binding.fileId}`, key);
      return { ok: true, key, fileId: binding.fileId, enabled: true, reason: 'привязка ' + (binding.mode || '') };
    }
  }

  if (!cfg.autoMatch) {
    await diag('матч: пропуск', false, 'автопоиск выключен в настройках', key);
    return { ok: true, key, fileId: null, enabled: true, reason: 'автопоиск выключен' };
  }

  const { file, reason } = await findMatch({ title, artists, durationMs: p.durationMs || 0 }, cfg);
  if (!file) {
    await noteMissing(key, title, artists, p.via);
    await diag('матч: не найден', false, reason, key);
    return { ok: true, key, fileId: null, enabled: true, reason };
  }

  try {
    await YMUDB.putBinding({
      key, fileId: file.id, mode: 'auto', disabled: false,
      title, artists, score: file.__score || 1, createdAt: Date.now(),
    });
  } catch (e) { /* привязку не сохранили, но файл отдадим */ }

  await diag('матч: найден', true, `${file.name || file.title} — ${reason}`, key);
  return { ok: true, key, fileId: file.id, enabled: true, reason: 'авто: ' + reason };
}

/* ---------- вставки ---------- */

/** Жребий на стыке треков: интервал, затем вероятность, затем случайный файл из пула. */
async function pickInsert(p) {
  const force = !!(p && p.force);   // «вставить после этого трека»: без интервала и жребия
  const cfg = await settings();
  if (!cfg.enabled) return { ok: true, fileId: null, reason: 'расширение выключено' };
  if (!cfg.insertEnabled) return { ok: true, fileId: null, reason: 'вставки выключены в настройках' };

  const gapMs = Math.max(0, Number(cfg.insertMinGapMin) || 0) * 60000;
  const last = Number(await YMUDB.getSetting('lastInsertAt', 0)) || 0;
  if (!force && last && Date.now() - last < gapMs) {
    const left = Math.ceil((gapMs - (Date.now() - last)) / 60000);
    return { ok: true, fileId: null, reason: `интервал: ещё ~${left} мин`, retryInMs: gapMs - (Date.now() - last) };
  }

  let pool = [];
  try { pool = (await YMUDB.allFiles()).filter((f) => f.insert); } catch (e) { pool = []; }
  if (!pool.length) {
    return { ok: true, fileId: null, reason: 'нет файлов с галочкой «Вставка» в библиотеке' };
  }

  const chance = Math.max(0, Math.min(1, Number(cfg.insertChance)));
  if (!force && !(Math.random() < chance)) {
    return { ok: true, fileId: null, reason: `не выпало (${Math.round(chance * 100)}%)` };
  }

  // не повторяем прошлую вставку, если есть из чего выбрать
  const lastId = await YMUDB.getSetting('lastInsertFileId', null);
  const choices = pool.length > 1 ? pool.filter((f) => f.id !== lastId) : pool;
  const f = choices[Math.floor(Math.random() * choices.length)];
  await diag('вставка: выпала', true, `${f.name || f.title}` + (force ? ', принудительно' : `, шанс ${Math.round(chance * 100)}%`));
  return {
    ok: true, fileId: f.id, title: f.title || '', artists: f.artists || '',
    mime: f.mime || 'audio/mpeg', cover: f.cover || null,
  };
}

/* ---------- автоимпорт скачанного ---------- */

function setIconBadge(n) {
  try {
    if (!chrome.action) return;
    chrome.action.setBadgeText({ text: n > 0 ? '+' + n : '' });
    if (n > 0) chrome.action.setBadgeBackgroundColor({ color: '#c9a6ff' });
  } catch (e) { /* ignore */ }
}

/** Скачанное → библиотека. После импорта сразу проверяем играющий трек. */
async function runImport(ask) {
  const res = await YMUImport.processQueue(YMUDB, { ask: !!ask });
  metaUpgraded = false;
  if (res.imported.length) {
    await diag('импорт: скачанное', true, res.imported.map((f) => f.name).join(', '));
    try { chrome.runtime.sendMessage({ kind: 'libraryChanged' }).catch(() => {}); } catch (e) {}
    await recheckCurrentTrack();
  }
  if (res.needPermission) await diag('импорт: нужен доступ к папке', false, 'открой попап и нажми «Импортировать»');
  if (res.noFolder && res.left) await diag('импорт: папка не выбрана', false, 'выбери папку загрузок в настройках');
  setIconBadge(res.left);
  return res;
}

/** Только что скачанный файл может быть ровно тем, что играет, — включаем его сразу. */
async function recheckCurrentTrack() {
  try {
    const last = await YMUDB.getSetting('lastTrack', null);
    if (!last || !last.title || Date.now() - (last.ts || 0) > 30 * 60 * 1000) return;
    const r = await resolveTrack({ title: last.title, artists: last.artists, durationMs: last.durationMs, via: last.via });
    if (r && r.fileId) notify({ kind: 'binding', data: { key: r.key, fileId: r.fileId } });
  } catch (e) { /* ignore */ }
}

if (chrome.downloads && chrome.downloads.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta || !delta.state || delta.state.current !== 'complete') return;
    (async () => {
      const cfg = await settings();
      if (!cfg.autoImport) return;
      const [item] = await chrome.downloads.search({ id: delta.id });
      if (!item || !YMUImport.isAudio(item.filename, item.mime)) return;
      const queue = (await YMUDB.getSetting('importQueue', [])) || [];
      const name = YMUImport.basename(item.filename);
      if (!queue.some((q) => q.id === item.id)) {
        queue.push({ id: item.id, name, size: item.fileSize || item.totalBytes || 0, at: Date.now() });
        await YMUDB.setSetting('importQueue', queue);
      }
      await runImport(false);
    })().catch((e) => console.error('[YMU] автоимпорт', e));
  });
}

/* ---------- утилиты ---------- */

async function blobToBase64Slice(blob, offset, length) {
  const slice = blob.slice(offset, Math.min(offset + length, blob.size));
  const buf = await slice.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function asBlob(rec) {
  return rec.blob instanceof Blob ? rec.blob : new Blob([rec.blob], { type: rec.mime || 'audio/mpeg' });
}

function notify(msg) {
  try {
    chrome.tabs.query({ url: '*://music.yandex.ru/*' }, (tabs) => {
      for (const t of tabs || []) {
        chrome.tabs.sendMessage(t.id, msg).catch(() => {});
      }
    });
  } catch (e) { /* ignore */ }
}

/* ---------- маршрутизация ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const type = msg && msg.type;
      const p = (msg && msg.payload) || {};

      switch (type) {
        case 'hello':
          sendResponse({ settings: await settings() });
          return;

        case 'track':
          sendResponse(await resolveTrack(p));
          return;

        case 'diag':
          await diag(p.stage || '?', p.ok, p.detail, p.key);
          sendResponse({ ok: true });
          return;

        case 'capture': {
          const cfg = await settings();
          if (cfg.capture) {
            try { await YMUDB.pushCapture({ ts: Date.now(), kind: p.kind || 'raw', data: p }); } catch (e) {}
          }
          sendResponse({ ok: true });
          return;
        }

        case 'fileInfo': {
          const rec = await YMUDB.getFile(p.fileId);
          if (!rec) { sendResponse({ ok: false, error: 'файл не найден в библиотеке' }); return; }
          const blob = asBlob(rec);
          if (!blob.size) { sendResponse({ ok: false, error: 'файл пустой — переимпортируй' }); return; }
          sendResponse({ ok: true, size: blob.size, mime: rec.mime || 'audio/mpeg', name: rec.name });
          return;
        }

        case 'fileChunk': {
          const rec = await YMUDB.getFile(p.fileId);
          if (!rec) { sendResponse({ ok: false, error: 'файл не найден' }); return; }
          const blob = asBlob(rec);
          const data = await blobToBase64Slice(blob, p.offset || 0, p.length || CHUNK);
          sendResponse({ ok: true, data, size: blob.size });
          return;
        }

        case 'bind': {
          const key = p.key || safeKey(p.title, p.artists);
          const file = await YMUDB.getFile(p.fileId);
          if (!file) { sendResponse({ ok: false, error: 'файл не найден' }); return; }
          await YMUDB.putBinding({
            key, fileId: p.fileId, mode: 'manual', disabled: false,
            title: p.title || file.title, artists: p.artists || file.artists,
            score: 1, createdAt: Date.now(),
          });
          await diag('привязка: вручную', true, `${file.name} → ${key}`, key);
          notify({ kind: 'binding', data: { key, fileId: p.fileId } });
          sendResponse({ ok: true, key, fileId: p.fileId });
          return;
        }

        case 'unbind':
          await YMUDB.deleteBinding(p.key);
          notify({ kind: 'binding', data: { key: p.key, fileId: null } });
          sendResponse({ ok: true });
          return;

        case 'disableTrack': {
          const b = await YMUDB.getBinding(p.key);
          if (b) { b.disabled = true; await YMUDB.putBinding(b); }
          else await YMUDB.putBinding({ key: p.key, fileId: null, mode: 'manual', disabled: true, createdAt: Date.now() });
          notify({ kind: 'binding', data: { key: p.key, fileId: null } });
          sendResponse({ ok: true });
          return;
        }

        case 'pickInsert':
          sendResponse(await pickInsert(p));
          return;

        case 'insertNext':
          notify({ kind: 'insertNext' });
          sendResponse({ ok: true });
          return;

        case 'probe':
          await YMUDB.setSetting('probe', null);
          notify({ kind: 'probe' });
          sendResponse({ ok: true });
          return;

        case 'probeResult':
          await YMUDB.setSetting('probe', p);
          sendResponse({ ok: true });
          return;

        case 'getMissing': {
          const list = (await YMUDB.getSetting('missing', [])) || [];
          // файл могли импортировать позже — такие треки из списка убираем
          const keys = new Set((await YMUDB.allFiles()).map((f) => f.key));
          const binds = await YMUDB.allBindings();
          for (const b of binds) if (b.fileId && !b.disabled) keys.add(b.key);
          sendResponse({ missing: list.filter((m) => !keys.has(m.key)) });
          return;
        }

        case 'hideMissing': {
          const list = (await YMUDB.getSetting('missing', [])) || [];
          const m = list.find((x) => x.key === p.key);
          if (m) { m.hidden = p.hidden !== false; await YMUDB.setSetting('missing', list); }
          sendResponse({ ok: true });
          return;
        }

        case 'importNow':
          sendResponse(await runImport(false));
          return;

        case 'importState': {
          const dir = await YMUDB.getSetting('importDir', null);
          const queue = (await YMUDB.getSetting('importQueue', [])) || [];
          sendResponse({ folder: dir ? dir.name : null, queue: queue.length });
          return;
        }

        case 'afterImport':
          metaUpgraded = false;
          // импорт сделала страница (там был клик и доступ к папке) — фону осталось проверить трек
          setIconBadge(((await YMUDB.getSetting('importQueue', [])) || []).length);
          await recheckCurrentTrack();
          sendResponse({ ok: true });
          return;

        case 'clearMissing':
          await YMUDB.setSetting('missing', []);
          sendResponse({ ok: true });
          return;

        case 'getProbe':
          sendResponse({ probe: await YMUDB.getSetting('probe', null) });
          return;

        case 'insertStarted':
          // интервал считаем от реального старта вставки, а не от жребия
          await YMUDB.setSetting('lastInsertAt', Date.now());
          if (p.fileId) await YMUDB.setSetting('lastInsertFileId', p.fileId);
          sendResponse({ ok: true });
          return;

        case 'settingsChanged':
          sendResponse({ ok: true });
          notify({ kind: 'state', data: { settings: await settings() } });
          return;

        case 'getLastTrack':
          sendResponse({ track: await YMUDB.getSetting('lastTrack', null) });
          return;

        case 'getDiag':
          sendResponse({ diag: await YMUDB.getSetting('diag', []) });
          return;

        case 'clearDiag':
          await YMUDB.setSetting('diag', []);
          sendResponse({ ok: true });
          return;

        default:
          sendResponse({ ok: false, error: 'неизвестный тип: ' + type });
      }
    } catch (e) {
      console.error('[YMU]', e);
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

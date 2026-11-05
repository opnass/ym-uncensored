/* background.js — service worker: единственный владелец нормализации и матчинга.
   Страница присылает сырые title/artists и получает готовый ответ
   { ok, key, fileId, enabled, reason }. */
'use strict';

importScripts('normalize.js', 'db.js');

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

async function findMatch(track, cfg) {
  let files = [];
  try { files = await YMUDB.allFiles(); } catch (e) { files = []; }
  if (!files.length) return { file: null, reason: 'библиотека пуста' };

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
        s = YMU.score(
          { title: f.title, artists: f.artists, durationMs: f.durationMs },
          { title: track.title, artists: track.artists, durationMs: track.durationMs }
        );
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

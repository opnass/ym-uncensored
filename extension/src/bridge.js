/* bridge.js — ISOLATED world. Только транспорт: страница ↔ service worker.
   Не зависит ни от normalize.js, ни от window.YMU: такая зависимость в 0.2.0
   обрывала всю цепочку.

   Передача файла сделана устойчивой к засыпанию service worker: у каждого шага
   есть таймаут, а залипшее состояние pending сбрасывается, иначе первая же
   неудачная попытка блокирует все последующие (это и вешало плашку
   на «файл найден, загружаю»). */
(function () {
  'use strict';

  const EVT_OUT = 'ymu:to-bridge';
  const EVT_IN = 'ymu:to-page';
  const CHUNK = 512 * 1024;
  const STEP_TIMEOUT = 8000;
  const STALE_MS = 20000;

  /** key -> {state:'pending'|'ready'|'failed', startedAt, transferId} */
  const state = new Map();
  let transferSeq = 0;

  function toPage(msg) {
    try {
      window.dispatchEvent(new CustomEvent(EVT_IN, { detail: JSON.stringify(msg) }));
    } catch (e) { /* ignore */ }
  }

  function reply(reqId, data) {
    if (!reqId) return;
    toPage({ kind: 'reply', reqId, data: data === undefined ? null : data });
  }

  /** sendMessage с таймаутом: зависший SW не должен вешать всю цепочку. */
  function send(type, payload, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => finish({ ok: false, error: 'таймаут ответа фона' }), timeoutMs || STEP_TIMEOUT);

      let p;
      try {
        p = chrome.runtime.sendMessage({ type, payload, page: location.href });
      } catch (e) {
        clearTimeout(timer);
        finish({ ok: false, error: 'нет связи с фоном: ' + ((e && e.message) || e) });
        return;
      }

      Promise.resolve(p).then(
        (v) => { clearTimeout(timer); finish(v == null ? { ok: false, error: 'пустой ответ фона' } : v); },
        (e) => {
          clearTimeout(timer);
          const m = String((e && e.message) || e);
          finish({ ok: false, error: 'нет связи с фоном: ' + m });
        }
      );
    });
  }

  /** Сбрасывает залипшие передачи, чтобы следующая попытка не блокировалась. */
  function isBlocked(key) {
    const st = state.get(key);
    if (!st) return false;
    if (st.state === 'ready') return true;
    if (st.state === 'failed') return false;
    if (st.state === 'pending' && Date.now() - (st.startedAt || 0) > STALE_MS) {
      state.delete(key);            // зависла — начинаем заново
      return false;
    }
    return st.state === 'pending';
  }

  async function fetchFile(key, fileId, reason) {
    if (isBlocked(key)) return;
    state.set(key, { state: 'pending', startedAt: Date.now() });

    const info = await send('fileInfo', { fileId });
    if (!info || !info.ok) {
      state.set(key, { state: 'failed' });
      toPage({ kind: 'audioError', data: { transferId: null, error: (info && info.error) || 'нет данных о файле' } });
      return;
    }

    const transferId = 't' + (++transferSeq);
    state.set(key, { state: 'pending', startedAt: Date.now(), transferId });
    toPage({ kind: 'audioStart', data: { transferId, key, size: info.size, mime: info.mime } });

    const chunks = Math.max(1, Math.ceil(info.size / CHUNK));
    let offset = 0;
    let sent = 0;
    let failures = 0;

    while (offset < info.size) {
      const res = await send('fileChunk', { fileId, offset, length: CHUNK });

      if (!res || !res.ok) {
        failures++;
        if (failures >= 2) {
          state.set(key, { state: 'failed' });
          toPage({ kind: 'audioError', data: { transferId, error: (res && res.error) || 'обрыв чтения' } });
          return;
        }
        continue;                    // одна повторная попытка на тот же чанк
      }

      failures = 0;
      toPage({ kind: 'audioChunk', data: { transferId, data: res.data } });
      offset += CHUNK;
      sent++;
      // прогресс: раз в 3 чанка, чтобы не заваливать страницу событиями
      if (sent % 3 === 0 || offset >= info.size) {
        toPage({ kind: 'audioProgress', data: { transferId, key, percent: Math.round((sent / chunks) * 100) } });
      }
    }

    toPage({ kind: 'audioDone', data: { transferId } });
    state.set(key, { state: 'ready', transferId });
  }

  /* ---------- страница → расширение ---------- */

  window.addEventListener(EVT_OUT, async (e) => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }
    const p = msg.payload || {};

    switch (msg.type) {
      case 'track': {
        const res = await send('track', p);
        reply(msg.reqId, res);
        break;
      }

      case 'needAudio': {
        // ответ сразу: страница не должна ждать всей передачи
        reply(msg.reqId, { ok: true });
        if (p.key && p.fileId) fetchFile(p.key, p.fileId, 'запрос страницы');
        break;
      }

      case 'diag': {
        await send('diag', p);
        reply(msg.reqId, { ok: true });
        break;
      }

      case 'capture': {
        await send('capture', p);
        reply(msg.reqId, { ok: true });
        break;
      }

      default: {
        // прозрачная пересылка: новый тип сообщения не должен требовать правки моста
        const res = await send(msg.type, p);
        reply(msg.reqId, res === null ? { ok: false, error: 'нет ответа фона' } : res);
      }
    }
  });

  /* ---------- расширение → страница ---------- */

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.kind) return;

    if (msg.kind === 'state') {
      toPage(msg);
      return;
    }

    if (msg.kind === 'binding') {
      const { key, fileId } = msg.data || {};
      if (fileId) {
        state.delete(key);           // новая привязка — начинаем передачу заново
        fetchFile(key, fileId, 'привязка');
      } else {
        state.delete(key);
      }
      toPage(msg);
    }
  });

  /* ---------- старт ---------- */

  (async () => {
    const data = await send('hello', null, 4000);
    if (data && data.settings) {
      toPage({ kind: 'state', data: { settings: data.settings } });
    }
  })();
})();

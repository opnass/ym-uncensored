/* popup.js — привязка текущего трека и панель диагностики. */
'use strict';

const $ = (id) => document.getElementById(id);
let currentTrack = null;
let files = [];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function setStatus(html, kind) {
  $('status').innerHTML = html ? `<div class="status ${kind || ''}">${html}</div>` : '';
}

function scoreOf(f) {
  return currentTrack
    ? YMU.score({ title: f.title, artists: f.artists, durationMs: f.durationMs }, currentTrack)
    : 0;
}

async function send(type, payload) {
  try {
    return await chrome.runtime.sendMessage({ type, payload });
  } catch (e) {
    return null;
  }
}

/* ---------- состояние ---------- */

async function loadState() {
  const s = await YMUDB.allSettings();
  const on = s.enabled !== false;
  $('enabled').checked = on;
  $('dot').classList.toggle('on', on);

  files = await YMUDB.allFiles();

  const r = await send('getLastTrack');
  const t = r && r.track;
  if (t && t.title) currentTrack = t;

  renderTrack();
  renderSelect();
  await renderBinding();
  await renderDiag();
}

function renderTrack() {
  if (!currentTrack) {
    $('tTitle').textContent = 'Трек не определён';
    $('tArtist').textContent = 'Включи воспроизведение в Яндекс.Музыке.';
    $('tKey').textContent = '';
    $('bindBtn').disabled = true;
    return;
  }
  $('tTitle').textContent = currentTrack.title || '—';
  $('tArtist').textContent = currentTrack.artists || '';
  $('tKey').textContent = 'ключ: ' + (currentTrack.key || '—');
  $('bindBtn').disabled = false;
}

function renderSelect() {
  const sel = $('fileSel');
  sel.innerHTML = '<option value="">— файл из библиотеки —</option>';

  if (!files.length) {
    const o = document.createElement('option');
    o.textContent = 'библиотека пуста';
    o.disabled = true;
    sel.appendChild(o);
    return;
  }

  const ranked = [...files].sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, 200);
  for (const f of ranked) {
    const o = document.createElement('option');
    o.value = f.id;
    const sc = scoreOf(f);
    o.textContent = `${f.artists ? f.artists + ' — ' : ''}${f.title}` + (sc > 0.6 ? `  ·  ${Math.round(sc * 100)}%` : '');
    sel.appendChild(o);
  }
  if (currentTrack && ranked.length && scoreOf(ranked[0]) > 0.6) sel.value = ranked[0].id;
}

async function renderBinding() {
  if (!currentTrack || !currentTrack.key) { $('bindHint').textContent = ''; $('unbindBtn').disabled = true; return; }
  const b = await YMUDB.getBinding(currentTrack.key);
  const hint = $('bindHint');

  if (b && b.fileId) {
    const f = files.find((x) => x.id === b.fileId);
    hint.innerHTML = `Привязано: <b>${esc(f ? f.name : 'файл удалён')}</b> · ${b.mode === 'manual' ? 'ручная' : 'авто'}`;
    $('unbindBtn').disabled = false;
  } else if (b && b.disabled) {
    hint.textContent = 'Для этого трека подмена отключена.';
    $('unbindBtn').disabled = false;
  } else {
    hint.textContent = 'Привязки нет. Выбери файл и нажми «Привязать».';
    $('unbindBtn').disabled = true;
  }
}

/* ---------- диагностика ---------- */

async function renderDiag() {
  const r = await send('getDiag');
  const rows = (r && r.diag) || [];
  const box = $('diagBox');

  if (!rows.length) {
    box.innerHTML = '<div class="hint">Записей нет. Включи трек в плеере, подожди 2 секунды и нажми ↻.</div>';
    return;
  }

  // решает последняя запись, а не первая ошибка в списке: раньше панель
  // бранила старый сбой, хотя привязка уже была рабочей
  const newest = rows[0];
  const swap = rows.find((x) => /подмена: применена/.test(x.stage));

  let summary = '';
  if (newest && !newest.ok) {
    summary = `<div class="summary bad">Оборвалось на: <b>${esc(newest.stage)}</b><br>`
      + `<span class="detail">${esc(newest.detail || '')}</span></div>`;
  } else if (swap) {
    summary = '<div class="summary ok">Подмена сработала. Если слышишь цензуру — файл не тот, что играет.</div>';
  } else if (newest && newest.ok) {
    summary = '<div class="summary ok">Привязка есть, файл отдаётся странице.</div>';
  }

  const html = rows.slice(0, 25).map((x) => {
    const time = new Date(x.ts).toLocaleTimeString('ru-RU');
    return `<div class="step">
      <span class="mark ${x.ok ? 'ok' : 'bad'}">${x.ok ? '✓' : '✕'}</span>
      <span class="body">
        <span class="stage">${esc(x.stage)}</span>
        <span class="detail">${esc(x.detail || '')}</span>
        <span class="detail">${time}</span>
      </span>
    </div>`;
  }).join('');

  box.innerHTML = summary + html;
}

/* ---------- действия ---------- */

$('enabled').addEventListener('change', async (e) => {
  const on = e.target.checked;
  await YMUDB.setSetting('enabled', on);
  $('dot').classList.toggle('on', on);
  chrome.runtime.sendMessage({ type: 'settingsChanged' }).catch(() => {});
});

$('bindBtn').addEventListener('click', async () => {
  if (!currentTrack) return setStatus('Сначала включи трек в плеере.', 'warn');
  const fileId = $('fileSel').value;
  if (!fileId) return setStatus('Выбери файл из списка.', 'warn');

  const f = files.find((x) => x.id === fileId);
  const res = await send('bind', {
    key: currentTrack.key, fileId,
    title: currentTrack.title, artists: currentTrack.artists,
  });

  if (res && res.ok) {
    setStatus(`Привязано: ${esc(f ? f.name : fileId)}. Подмена применится сразу.`, 'ok');
    await renderBinding();
    setTimeout(renderDiag, 600);
  } else {
    setStatus('Не вышло: ' + esc((res && res.error) || 'нет ответа от фонового скрипта'), 'bad');
  }
});

$('unbindBtn').addEventListener('click', async () => {
  if (!currentTrack || !currentTrack.key) return;
  await send('unbind', { key: currentTrack.key });
  setStatus('Привязка снята.', 'warn');
  await renderBinding();
  setTimeout(renderDiag, 400);
});

$('openOpts').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('refreshDiag').addEventListener('click', async () => {
  await loadState();
  setStatus('Обновлено.', 'ok');
});

(async function init() {
  await loadState();
  setInterval(async () => {
    const r = await send('getLastTrack');
    const t = r && r.track;
    if (t && t.title && (!currentTrack || t.key !== currentTrack.key)) {
      currentTrack = t;
      renderTrack();
      renderSelect();
      await renderBinding();
      await renderDiag();
    }
  }, 1500);
})();

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

/* ---------- скачанное ждёт импорта ---------- */

async function renderImportCard() {
  const r = await send('importState');
  const n = (r && r.queue) || 0;
  $('importCard').style.display = n ? 'block' : 'none';
  if (!n) return;
  $('importText').textContent = r.folder
    ? `Скачано новых треков: ${n}`
    : `Скачано треков: ${n}. Выбери папку загрузок в настройках`;
  $('importBtn').textContent = r.folder ? 'Импортировать' : 'Настройки';
}

$('importBtn').addEventListener('click', async () => {
  const st = await send('importState');
  if (!st || !st.folder) { chrome.runtime.openOptionsPage(); return; }
  // здесь есть клик — Chrome может спросить доступ к папке
  const res = await YMUImport.processQueue(YMUDB, { ask: true });
  await send('afterImport');
  if (res.needPermission) setStatus('Chrome не дал доступ к папке загрузок.', 'bad');
  else setStatus(`Импортировано: ${res.imported.length}` + (res.notFound.length ? `, не найдено в папке: ${res.notFound.length}` : ''), 'ok');
  files = await YMUDB.allFiles();
  renderSelect();
  await renderImportCard();
});

/* ---------- поиск explicit-версии на сайтах ---------- */

async function renderSearch() {
  const row = $('searchRow'), box = $('searchBtns');
  if (!currentTrack || !currentTrack.title) { row.style.display = 'none'; return; }
  const state = await YMUSites.load(YMUDB);
  const sites = YMUSites.ordered(state);
  box.innerHTML = '';
  if (!sites.length) {
    box.innerHTML = '<span class="hint">Сайты выключены — включи их в настройках («Где искать»).</span>';
  }
  for (const site of sites) {
    const a = document.createElement('a');
    a.className = 'site' + (site.id === state.defaultId ? ' main' : '');
    a.href = YMUSites.buildUrl(site, currentTrack);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = site.name;
    a.title = 'Искать «' + YMUSites.cleanQuery(currentTrack) + '» на ' + site.name;
    box.appendChild(a);
  }
  row.style.display = 'block';
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
  renderImportCard();
  await renderBinding();
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
  renderSearch();
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
  } else {
    setStatus('Не вышло: ' + esc((res && res.error) || 'нет ответа от фонового скрипта'), 'bad');
  }
});

$('unbindBtn').addEventListener('click', async () => {
  if (!currentTrack || !currentTrack.key) return;
  await send('unbind', { key: currentTrack.key });
  setStatus('Привязка снята.', 'warn');
  await renderBinding();
});

$('openOpts').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('insertNext').addEventListener('click', async () => {
  const s = await YMUDB.allSettings();
  if (!s.insertEnabled) { setStatus('Сначала включи вставки в «Библиотеке и настройках».', 'bad'); return; }
  const pool = (await YMUDB.allFiles()).filter((f) => f.insert);
  if (!pool.length) { setStatus('Нет файлов с галочкой «Вставка» в библиотеке.', 'bad'); return; }
  await send('insertNext');
  setStatus('Вставка сыграет, когда текущий трек доиграет. Можно перемотать трек к концу.', 'ok');
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
        }
  }, 1500);
})();

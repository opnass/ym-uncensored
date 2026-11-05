/* options.js — импорт библиотеки, настройки, просмотр привязок. */
'use strict';

const $ = (id) => document.getElementById(id);
const toastEl = $('toast');

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function fmtDur(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtSize(b) {
  if (!b) return '—';
  return (b / 1048576).toFixed(1) + ' МБ';
}

/** Читает длительность файла через временный audio-элемент. */
function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(v || 0);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => finish(Math.round(a.duration * 1000));
    a.onerror = () => finish(0);
    setTimeout(() => finish(0), 5000);
    a.src = url;
  });
}

/** «Исполнитель - Название» -> {artists, title}. */
function parseName(filename) {
  const base = filename.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = base.split(/\s+[-–—]\s+/);
  if (m.length >= 2) {
    return { artists: m[0].trim(), title: m.slice(1).join(' - ').trim() };
  }
  return { artists: '', title: base };
}

async function saveSettings() {
  await YMUDB.setSetting('enabled', $('enabled').checked);
  await YMUDB.setSetting('autoMatch', $('autoMatch').checked);
  await YMUDB.setSetting('fuzzy', $('fuzzy').checked);
  await YMUDB.setSetting('mode', $('mode').value);
  await YMUDB.setSetting('threshold', parseFloat($('threshold').value));
  await YMUDB.setSetting('capture', $('capture').checked);
  chrome.runtime.sendMessage({ type: 'settingsChanged' }).catch(() => {});
}

async function loadSettings() {
  const s = await YMUDB.allSettings();
  $('enabled').checked = s.enabled !== false;
  $('autoMatch').checked = s.autoMatch !== false;
  $('fuzzy').checked = s.fuzzy !== false;
  $('mode').value = s.mode || 'always';
  $('threshold').value = s.threshold ?? 0.82;
  $('thresholdV').textContent = Number($('threshold').value).toFixed(2);
  $('capture').checked = !!s.capture;
}

async function importFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|flac|ogg|wav|opus|aac)$/i.test(f.name));
  if (!files.length) { toast('Аудиофайлов не найдено'); return; }

  let added = 0;
  for (const f of files) {
    try {
      const { artists, title } = parseName(f.name);
      const durationMs = await readDuration(f);
      const id = crypto.randomUUID();
      await YMUDB.putFile({
        id,
        name: f.name,
        title,
        artists,
        key: YMU.trackKey(title, artists),
        durationMs,
        size: f.size,
        mime: f.type || 'audio/mpeg',
        blob: f,
        addedAt: Date.now(),
      });
      added++;
    } catch (e) {
      console.error('[YMU] импорт не удался', f.name, e);
    }
  }
  toast(`Добавлено файлов: ${added}`);
  await renderLibrary();
}

async function renderLibrary() {
  const files = await YMUDB.allFiles();
  files.sort((a, b) => a.key.localeCompare(b.key));
  const body = $('libBody');
  body.innerHTML = '';
  $('libCount').textContent = files.length ? `— ${files.length}` : '— пусто';

  if (!files.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">Пока ничего не импортировано.</td></tr>';
    return;
  }

  for (const f of files) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div>${escapeHtml(f.name)}</div><div class="mono">${escapeHtml(f.key)}</div></td>
      <td>${escapeHtml(f.artists || '—')}<div class="muted" style="font-size:12px">${escapeHtml(f.title)}</div></td>
      <td class="mono">${fmtDur(f.durationMs)}</td>
      <td class="mono">${fmtSize(f.size)}</td>
      <td></td>`;
    const del = document.createElement('button');
    del.textContent = 'Удалить';
    del.className = 'danger';
    del.onclick = async () => {
      await YMUDB.deleteFile(f.id);
      toast('Файл удалён');
      await renderLibrary();
    };
    tr.lastElementChild.appendChild(del);
    body.appendChild(tr);
  }
}

async function renderBindings() {
  const [rows, files] = await Promise.all([YMUDB.allBindings(), YMUDB.allFiles()]);
  const byId = new Map(files.map((f) => [f.id, f]));
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const body = $('bindBody');
  body.innerHTML = '';
  $('bindCount').textContent = rows.length ? `— ${rows.length}` : '— пусто';

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">Пока нет привязок. Открой трек в плеере и нажми «Привязать» в попапе.</td></tr>';
    return;
  }

  for (const b of rows) {
    const f = byId.get(b.fileId);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(b.artists || '—')}<div class="muted" style="font-size:12px">${escapeHtml(b.title || '')}</div>
          <div class="mono">${f ? escapeHtml(f.name) : 'файл удалён'}</div></td>
      <td class="mono">${escapeHtml(String(b.key))}</td>
      <td class="mono">${b.score ? Number(b.score).toFixed(2) : '—'}</td>
      <td><span class="pill ${b.mode === 'manual' ? 'manual' : 'auto'}">${b.mode === 'manual' ? 'ручная' : 'авто'}</span>
          ${b.disabled ? ' <span class="pill auto">выкл</span>' : ''}</td>
      <td></td>`;
    const del = document.createElement('button');
    del.textContent = 'Разорвать';
    del.className = 'danger';
    del.onclick = async () => {
      await YMUDB.deleteBinding(b.trackId);
      toast('Привязка удалена');
      await renderBindings();
    };
    tr.lastElementChild.appendChild(del);
    body.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- обработчики ---------- */

$('drop').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => importFiles(e.target.files));

['dragenter', 'dragover'].forEach((ev) =>
  $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('hot'); }));
['dragleave', 'drop'].forEach((ev) =>
  $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('hot'); }));
$('drop').addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files);
});

for (const id of ['enabled', 'autoMatch', 'fuzzy', 'mode', 'capture']) {
  $(id).addEventListener('change', saveSettings);
}
$('threshold').addEventListener('input', () => {
  $('thresholdV').textContent = Number($('threshold').value).toFixed(2);
});
$('threshold').addEventListener('change', saveSettings);

$('exportCapture').onclick = async () => {
  const rows = await YMUDB.allCapture();
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ymu-capture-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Выгружено записей: ${rows.length}`);
};

$('clearCapture').onclick = async () => {
  await YMUDB.clearCapture();
  toast('Захват очищен');
};

(async function init() {
  await loadSettings();
  await renderLibrary();
  await renderBindings();
})();

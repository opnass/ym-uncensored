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

async function saveSettings() {
  await YMUDB.setSetting('enabled', $('enabled').checked);
  await YMUDB.setSetting('autoMatch', $('autoMatch').checked);
  await YMUDB.setSetting('fuzzy', $('fuzzy').checked);
  await YMUDB.setSetting('mode', $('mode').value);
  await YMUDB.setSetting('threshold', parseFloat($('threshold').value));
  await YMUDB.setSetting('capture', $('capture').checked);
  await YMUDB.setSetting('badge', $('badge').checked);
  await YMUDB.setSetting('insertEnabled', $('insertEnabled').checked);
  await YMUDB.setSetting('insertOnSkip', $('insertOnSkip').checked);
  await YMUDB.setSetting('autoImport', $('autoImport').checked);
  await YMUDB.setSetting('insertChance', Number($('insertChance').value) / 100);
  await YMUDB.setSetting('insertMinGapMin', Math.max(0, parseInt($('insertMinGapMin').value, 10) || 0));
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
  $('badge').checked = s.badge !== false;
  $('insertEnabled').checked = !!s.insertEnabled;
  $('insertOnSkip').checked = s.insertOnSkip !== false;
  $('autoImport').checked = s.autoImport !== false;
  $('insertChance').value = Math.round((s.insertChance ?? 0.2) * 100);
  $('insertChanceV').textContent = $('insertChance').value + '%';
  $('insertMinGapMin').value = s.insertMinGapMin ?? 15;
}

async function importFiles(fileList) {
  const files = Array.from(fileList).filter((f) => YMUImport.isAudio(f.name, f.type));
  if (!files.length) { toast('Аудиофайлов не найдено'); return; }

  let added = 0;
  for (const f of files) {
    try {
      const rec = await YMUImport.makeRecord(f, { durationMs: await readDuration(f), source: 'manual' });
      await YMUDB.putFile(rec);
      added++;
    } catch (e) {
      console.error('[YMU] импорт не удался', f.name, e);
    }
  }
  toast(`Добавлено файлов: ${added}`);
  await afterLibraryChange();
}

async function afterLibraryChange() {
  await renderLibrary();
  await renderMissing();
  await renderImport();
  chrome.runtime.sendMessage({ type: 'afterImport' }).catch(() => {});
}

/** Файлы, импортированные до 0.7.2, ещё без обложки: достаём её один раз. */
async function backfillCovers(files) {
  // обложки (до 0.7.2) и длительности (файлы, которые импортировал фон: там нет <audio>)
  const todo = files.filter((f) => f.blob && (!f.coverChecked || (!f.durationMs && !f.durationChecked)));
  if (!todo.length) return false;
  for (const f of todo) {
    const blob = f.blob instanceof Blob ? f.blob : new Blob([f.blob], { type: f.mime });
    const upd = {};
    if (!f.coverChecked) {
      try { upd.cover = await YMUCover.coverOf(blob); } catch (e) { upd.cover = null; }
      upd.coverChecked = true;
    }
    if (!f.durationMs && !f.durationChecked) {
      upd.durationMs = await readDuration(blob);
      upd.durationChecked = true;
    }
    await YMUDB.putFile(Object.assign({}, f, upd));
  }
  return true;
}

async function renderLibrary() {
  let files = await YMUDB.allFiles();
  if (await backfillCovers(files)) files = await YMUDB.allFiles();
  files.sort((a, b) => a.key.localeCompare(b.key));
  const body = $('libBody');
  body.innerHTML = '';
  $('libCount').textContent = files.length ? `— ${files.length}` : '— пусто';

  if (!files.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted">Пока ничего не импортировано.</td></tr>';
    return;
  }

  for (const f of files) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div class="fname">${f.cover ? `<img class="cover" src="${f.cover}" alt="">` : '<span class="cover" title="Обложки в файле нет — будет заглушка" style="display:inline-block"></span>'}<div><div>${escapeHtml(f.name)}</div><div class="mono">${escapeHtml(f.key)}</div></div></div></td>
      <td>${escapeHtml(f.artists || '—')}<div class="muted" style="font-size:12px">${escapeHtml(f.title)}</div></td>
      <td class="mono">${fmtDur(f.durationMs)}</td>
      <td class="mono">${fmtSize(f.size)}</td>
      <td></td>
      <td></td>`;
    const ins = document.createElement('input');
    ins.type = 'checkbox';
    ins.checked = !!f.insert;
    ins.title = 'Использовать этот файл для вставок в «Мою волну»';
    ins.onchange = async () => {
      await YMUDB.putFile(Object.assign({}, f, { insert: ins.checked }));
      f.insert = ins.checked;
      toast(ins.checked ? 'Файл добавлен во вставки' : 'Файл убран из вставок');
    };
    tr.children[4].appendChild(ins);
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
      await YMUDB.deleteBinding(b.key);
      toast('Привязка удалена');
      await renderBindings();
    };
    tr.lastElementChild.appendChild(del);
    body.appendChild(tr);
  }
}

/* ---------- автоимпорт скачанного ---------- */

async function renderImport() {
  const dir = await YMUDB.getSetting('importDir', null);
  const queue = (await YMUDB.getSetting('importQueue', [])) || [];
  $('importFolder').textContent = dir ? dir.name : 'не выбрана';
  $('importQueue').textContent = queue.length ? `(${queue.length})` : '';
  let perm = 'нет папки';
  if (dir) perm = await YMUImport.permission(dir, false);
  const granted = perm === 'granted';
  $('importPerm').textContent = !dir ? '' : granted ? '· доступ есть' : '· нужно разрешить доступ';
  $('importPerm').style.color = granted ? '#7ee27e' : '#e8c47a';
  $('grantFolder').style.display = dir && !granted ? '' : 'none';
  $('importNow').disabled = !queue.length;
  $('scanFolder').disabled = !dir;
}

function importResultText(res) {
  if (res.noFolder) return 'Сначала выбери папку загрузок';
  if (res.needPermission) return 'Chrome не дал доступ к папке';
  const parts = [`Импортировано: ${res.imported.length}`];
  if (res.skipped && (res.skipped.length || res.skipped > 0)) parts.push(`уже в библиотеке: ${res.skipped.length ?? res.skipped}`);
  if (res.notFound && res.notFound.length) parts.push(`не найдено в папке: ${res.notFound.length}`);
  return parts.join(', ');
}

$('pickFolder').onclick = async () => {
  if (typeof showDirectoryPicker !== 'function') { toast('Этот браузер не умеет выбирать папку'); return; }
  try {
    const dir = await showDirectoryPicker({ id: 'ymu-downloads', mode: 'read', startIn: 'downloads' });
    await YMUDB.setSetting('importDir', dir);
    toast(`Папка выбрана: ${dir.name}`);
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('Не удалось выбрать папку: ' + (e.message || e.name));
  }
  await renderImport();
};

$('grantFolder').onclick = async () => {
  const dir = await YMUDB.getSetting('importDir', null);
  const st = await YMUImport.permission(dir, true);
  toast(st === 'granted' ? 'Доступ к папке есть' : 'Доступ не дан');
  await renderImport();
};

$('importNow').onclick = async () => {
  const res = await YMUImport.processQueue(YMUDB, { ask: true, readDuration });
  toast(importResultText(res));
  await afterLibraryChange();
};

$('scanFolder').onclick = async () => {
  $('scanFolder').disabled = true;
  toast('Сканирую папку…');
  const res = await YMUImport.scanFolder(YMUDB, { ask: true, readDuration });
  toast(importResultText(res));
  await afterLibraryChange();
};

// фон импортировал скачанный файл — обновляем таблицы
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.kind === 'libraryChanged') { renderLibrary(); renderMissing(); renderImport(); }
});

/* ---------- где искать ---------- */

let sitesState = null;

async function renderSites() {
  sitesState = await YMUSites.load(YMUDB);
  const body = $('sitesBody');
  body.innerHTML = '';
  for (const site of sitesState.sites) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td></td><td>${escapeHtml(site.name)}</td><td></td><td></td>`;

    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = !!site.enabled;
    on.onchange = async () => { site.enabled = on.checked; await persistSites(); };
    tr.children[0].appendChild(on);

    const def = document.createElement('input');
    def.type = 'radio';
    def.name = 'searchDefault';
    def.checked = site.id === sitesState.defaultId;
    def.disabled = !site.enabled;
    def.onchange = async () => { sitesState.defaultId = site.id; await persistSites(); };
    tr.children[1].appendChild(def);

    const url = document.createElement('input');
    url.type = 'text';
    url.className = 'url';
    url.value = site.url;
    url.onchange = async () => {
      if (!YMUSites.validTemplate(url.value)) { toast('Ссылка должна начинаться с https:// и содержать {q}'); url.value = site.url; return; }
      site.url = url.value.trim();
      await persistSites();
    };
    tr.children[3].appendChild(url);

    if (site.custom) {
      const del = document.createElement('button');
      del.textContent = 'Удалить';
      del.className = 'danger';
      del.onclick = async () => {
        sitesState.sites = sitesState.sites.filter((s) => s !== site);
        await persistSites();
      };
      tr.children[4].appendChild(del);
    }
    body.appendChild(tr);
  }
}

async function persistSites() {
  const def = sitesState.sites.find((s) => s.id === sitesState.defaultId && s.enabled);
  if (!def) {
    const first = sitesState.sites.find((s) => s.enabled);
    sitesState.defaultId = first ? first.id : null;
  }
  await YMUSites.save(YMUDB, sitesState.sites, sitesState.defaultId);
  await renderSites();
  await renderMissing();
}

$('siteAdd').onclick = async () => {
  const name = $('siteName').value.trim();
  const url = $('siteUrl').value.trim();
  if (!name) { toast('Укажи название сайта'); return; }
  if (!YMUSites.validTemplate(url)) { toast('Ссылка должна начинаться с https:// и содержать {q}'); return; }
  sitesState.sites.push({ id: 'custom-' + Date.now(), name, url, enabled: true, custom: true });
  $('siteName').value = '';
  $('siteUrl').value = '';
  await persistSites();
  toast('Сайт добавлен');
};

/* ---------- треки без файла ---------- */

async function renderMissing() {
  const r = await chrome.runtime.sendMessage({ type: 'getMissing' }).catch(() => null);
  const all = (r && r.missing) || [];
  const showHidden = $('missShowHidden').checked;
  const rows = all.filter((m) => showHidden || !m.hidden);
  const body = $('missBody');
  body.innerHTML = '';
  const visible = all.filter((m) => !m.hidden).length;
  $('missCount').textContent = visible ? `— ${visible}` : '— пусто';

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="muted">Здесь появятся треки, которые играли без локальной версии.</td></tr>';
    return;
  }
  const sites = sitesState ? YMUSites.ordered(sitesState) : [];
  for (const m of rows) {
    const tr = document.createElement('tr');
    if (m.hidden) tr.className = 'hidden';
    tr.innerHTML = `
      <td>${escapeHtml(m.artists || '—')}<div class="muted" style="font-size:12px">${escapeHtml(m.title)}</div></td>
      <td class="mono">${m.count || 1}×</td>
      <td></td>
      <td></td>`;
    if (!sites.length) tr.children[2].innerHTML = '<span class="muted">включи сайты выше</span>';
    for (const site of sites) {
      const a = document.createElement('a');
      a.className = 'site' + (site.id === sitesState.defaultId ? ' main' : '');
      a.href = YMUSites.buildUrl(site, m);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = site.name;
      tr.children[2].appendChild(a);
    }
    const hide = document.createElement('button');
    hide.textContent = m.hidden ? 'Вернуть' : 'Скрыть';
    hide.title = m.hidden ? 'Снова показывать в списке' : 'Explicit-версия не нужна — не показывать';
    hide.onclick = async () => {
      await chrome.runtime.sendMessage({ type: 'hideMissing', payload: { key: m.key, hidden: !m.hidden } }).catch(() => {});
      await renderMissing();
    };
    tr.children[3].appendChild(hide);
    body.appendChild(tr);
  }
}

$('missShowHidden').addEventListener('change', renderMissing);
$('missClear').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'clearMissing' }).catch(() => {});
  toast('Список очищен');
  await renderMissing();
};

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

for (const id of ['enabled', 'autoMatch', 'fuzzy', 'mode', 'capture', 'insertEnabled', 'insertOnSkip', 'insertMinGapMin', 'autoImport', 'badge']) {
  $(id).addEventListener('change', saveSettings);
}
$('threshold').addEventListener('input', () => {
  $('thresholdV').textContent = Number($('threshold').value).toFixed(2);
});
$('threshold').addEventListener('change', saveSettings);
$('insertChance').addEventListener('input', () => {
  $('insertChanceV').textContent = $('insertChance').value + '%';
});
$('insertChance').addEventListener('change', saveSettings);

/* ---------- отладка: отчёт ---------- */

$('report').onclick = async () => {
  const send = (type) => chrome.runtime.sendMessage({ type }).catch(() => null);
  toast('Собираю отчёт…');
  await send('probe');
  let probe = null;
  for (let i = 0; i < 10 && !probe; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const r = await send('getProbe');
    probe = r && r.probe;
  }
  const s = await YMUDB.allSettings();
  const lib = await YMUDB.allFiles();
  const d = await send('getDiag');
  const report = {
    extension: chrome.runtime.getManifest().version,
    settings: { enabled: s.enabled !== false, threshold: s.threshold, insertEnabled: !!s.insertEnabled,
      insertChance: s.insertChance, insertMinGapMin: s.insertMinGapMin, insertOnSkip: s.insertOnSkip !== false,
      autoImport: s.autoImport !== false },
    library: { files: lib.length, insert: lib.filter((f) => f.insert).length, covers: lib.filter((f) => f.cover).length,
      fromTags: lib.filter((f) => f.fromTags).length },
    page: probe || 'вкладка не ответила — открой music.yandex.ru и обнови её',
    diag: ((d && d.diag) || []).slice(0, 30).map((x) =>
      `${new Date(x.ts).toLocaleTimeString()} ${x.ok ? '✓' : '✗'} ${x.stage}${x.detail ? ' — ' + x.detail : ''}`),
  };
  const text = JSON.stringify(report, null, 2);
  const box = $('reportBox');
  box.value = text;
  box.style.display = 'block';
  box.select();
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; } catch (e) {
    try { copied = document.execCommand('copy'); } catch (err) { copied = false; }
  }
  toast(copied ? 'Отчёт скопирован — вставь его в чат (Ctrl+V)' : 'Выдели текст и скопируй (Ctrl+C)');
};

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
  await renderSites();
  await renderMissing();
  await renderImport();
  await renderLibrary();
  await renderBindings();
})();

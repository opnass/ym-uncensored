/* importer.js — импорт аудиофайлов в библиотеку. Общий для фона и страницы настроек.

   Автоимпорт скачанного (0.9.0): фон видит завершённые загрузки Chrome (chrome.downloads),
   ставит аудиофайлы в очередь и читает их из папки, которую пользователь один раз выбрал
   (File System Access). Расширение ничего не скачивает само — только подхватывает то,
   что пользователь уже скачал. */
(function (root) {
  'use strict';

  const AUDIO_RE = /\.(mp3|m4a|mp4|aac|flac|ogg|oga|opus|wav)$/i;
  const MAX_DEPTH = 2;            // сколько уровней подпапок просматривать

  function isAudio(name, mime) {
    return AUDIO_RE.test(String(name || '')) || /^audio\//i.test(String(mime || ''));
  }

  function basename(p) {
    return String(p || '').split(/[\\/]/).pop();
  }

  /** «Исполнитель - Название» → {artists, title}. Метки сайтов вроде «(hitmo.net)» убираем. */
  function parseName(filename) {
    const base = String(filename || '').replace(/\.[^.]+$/, '').replace(/_/g, ' ')
      .replace(/[([]\s*(?:www\.)?[\w-]+\.(?:net|com|ru|org|me|cc|io|to|su|fm|club|pro|xyz)\s*[)\]]/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    const m = base.split(/\s+[-–—]\s+/);
    if (m.length >= 2) return { artists: m[0].trim(), title: m.slice(1).join(' - ').trim() };
    return { artists: '', title: base };
  }

  function mimeOf(file) {
    if (file.type) return file.type;
    const ext = (String(file.name).match(/\.([^.]+)$/) || [])[1] || '';
    return ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
      ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav' })[ext.toLowerCase()] || 'audio/mpeg';
  }

  /** Исполнитель и название: теги файла надёжнее имени («Мукка Таблетка.mp3» без « - »). */
  async function metaOf(file) {
    const byName = parseName(file.name);
    let tags = null;
    try { tags = root.YMUCover && root.YMUCover.tagsOfBlob ? await root.YMUCover.tagsOfBlob(file) : null; } catch (e) { tags = null; }
    const clean = (s) => String(s || '').replace(/[([]\s*(?:www\.)?[\w-]+\.(?:net|com|ru|org|me|cc|io|to|su|fm|club|pro|xyz)\s*[)\]]/gi, ' ').replace(/\s+/g, ' ').trim();
    const title = clean(tags && tags.title) || byName.title;
    const artists = clean(tags && tags.artist) || byName.artists;
    return { title, artists, nameTitle: byName.title, nameArtists: byName.artists, fromTags: !!(tags && (tags.title || tags.artist)) };
  }

  /** Запись библиотеки из файла. durationMs можно не знать — страница настроек дочитает её. */
  async function makeRecord(file, opts) {
    opts = opts || {};
    const meta = await metaOf(file);
    const { artists, title } = meta;
    let cover = null;
    try { cover = root.YMUCover ? await root.YMUCover.coverOf(file) : null; } catch (e) { cover = null; }
    const id = (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID()
      : 'f-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    return {
      id,
      name: file.name,
      title,
      artists,
      key: root.YMU.trackKey(title, artists),
      durationMs: opts.durationMs || 0,
      durationChecked: !!opts.durationMs,
      size: file.size,
      mime: mimeOf(file),
      blob: file,
      cover,
      coverChecked: true,
      nameTitle: meta.nameTitle,
      nameArtists: meta.nameArtists,
      fromTags: meta.fromTags,
      metaChecked: 2,
      addedAt: Date.now(),
      source: opts.source || 'manual',
    };
  }

  /** Такой файл уже в библиотеке (то же имя и размер). */
  function isDuplicate(files, file) {
    return files.some((f) => f.name === file.name && f.size === file.size);
  }

  /** Файл по имени (и размеру, если известен) в папке и подпапках. */
  async function findInDir(dir, name, size, depth) {
    depth = depth === undefined ? MAX_DEPTH : depth;
    const subdirs = [];
    for await (const [n, h] of dir.entries()) {
      if (h.kind === 'file' && n === name) {
        const f = await h.getFile();
        if (!size || f.size === size) return f;
      } else if (h.kind === 'directory' && depth > 0) {
        subdirs.push(h);
      }
    }
    for (const d of subdirs) {
      const f = await findInDir(d, name, size, depth - 1);
      if (f) return f;
    }
    return null;
  }

  /** Все аудиофайлы папки (для «Сканировать папку»). */
  async function listAudio(dir, depth, out) {
    depth = depth === undefined ? MAX_DEPTH : depth;
    out = out || [];
    for await (const [n, h] of dir.entries()) {
      if (h.kind === 'file' && isAudio(n)) out.push(await h.getFile());
      else if (h.kind === 'directory' && depth > 0) await listAudio(h, depth - 1, out);
    }
    return out;
  }

  async function permission(dir, ask) {
    if (!dir || typeof dir.queryPermission !== 'function') return 'denied';
    let st = 'prompt';
    try { st = await dir.queryPermission({ mode: 'read' }); } catch (e) { st = 'prompt'; }
    if (st !== 'granted' && ask && typeof dir.requestPermission === 'function') {
      try { st = await dir.requestPermission({ mode: 'read' }); } catch (e) { /* нужен клик пользователя */ }
    }
    return st;
  }

  /** Очередь скачанного → библиотека. ask=true только там, где есть клик пользователя. */
  async function processQueue(db, opts) {
    opts = opts || {};
    const queue = (await db.getSetting('importQueue', [])) || [];
    const res = { imported: [], notFound: [], skipped: [], left: queue.length, needPermission: false, noFolder: false };
    if (!queue.length) return res;

    const dir = await db.getSetting('importDir', null);
    if (!dir) { res.noFolder = true; return res; }
    if ((await permission(dir, opts.ask)) !== 'granted') { res.needPermission = true; return res; }

    const files = await db.allFiles();
    const rest = [];
    for (const q of queue) {
      let file = null;
      try { file = await findInDir(dir, q.name, q.size); } catch (e) { file = null; }
      if (!file) {
        // файл не в выбранной папке (или его уже убрали) — держим немного и забываем
        if (Date.now() - (q.at || 0) < 10 * 60 * 1000) rest.push(q);
        res.notFound.push(q.name);
        continue;
      }
      if (isDuplicate(files, file)) { res.skipped.push(file.name); continue; }
      const durationMs = opts.readDuration ? await opts.readDuration(file) : 0;
      const rec = await makeRecord(file, { durationMs, source: 'download' });
      await db.putFile(rec);
      files.push(rec);
      res.imported.push(rec);
    }
    await db.setSetting('importQueue', rest);
    res.left = rest.length;
    return res;
  }

  /** Импорт всех аудиофайлов папки, которых ещё нет в библиотеке. */
  async function scanFolder(db, opts) {
    opts = opts || {};
    const res = { imported: [], skipped: 0, needPermission: false, noFolder: false };
    const dir = await db.getSetting('importDir', null);
    if (!dir) { res.noFolder = true; return res; }
    if ((await permission(dir, opts.ask)) !== 'granted') { res.needPermission = true; return res; }
    const files = await db.allFiles();
    for (const file of await listAudio(dir)) {
      if (isDuplicate(files, file)) { res.skipped++; continue; }
      const durationMs = opts.readDuration ? await opts.readDuration(file) : 0;
      const rec = await makeRecord(file, { durationMs, source: 'folder' });
      await db.putFile(rec);
      files.push(rec);
      res.imported.push(rec);
    }
    return res;
  }

  const api = { isAudio, basename, parseName, metaOf, makeRecord, isDuplicate, findInDir, listAudio, permission, processQueue, scanFolder };
  root.YMUImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

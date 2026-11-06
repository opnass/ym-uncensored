/* cover.js — обложка, встроенная в аудиофайл. Работает на странице настроек.
   Поддержка: MP3 (ID3v2.2–2.4, кадр APIC/PIC), FLAC (блок PICTURE), M4A/MP4 (атом covr).
   Возвращает { mime, bytes } или null. Без зависимостей: парсим байты сами. */
(function (root) {
  'use strict';

  const ascii = (b, o, n) => String.fromCharCode.apply(null, b.subarray(o, o + n));
  const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const u24 = (b, o) => (b[o] << 16) + (b[o + 1] << 8) + b[o + 2];
  const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

  /** Тип картинки по сигнатуре: mime в тегах часто врёт или пустой. */
  function sniff(bytes, fallback) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
    if (ascii(bytes, 0, 3) === 'GIF') return 'image/gif';
    return fallback || 'image/jpeg';
  }

  /** Конец строки в кадре ID3 с учётом кодировки (UTF-16 — двойной ноль). */
  function skipString(b, o, end, enc) {
    if (enc === 1 || enc === 2) {
      while (o + 1 < end && !(b[o] === 0 && b[o + 1] === 0)) o += 2;
      return o + 2;
    }
    while (o < end && b[o] !== 0) o++;
    return o + 1;
  }

  function fromId3(b) {
    if (b.length < 10 || ascii(b, 0, 3) !== 'ID3') return null;
    const ver = b[3];
    const flags = b[5];
    const tagEnd = Math.min(b.length, 10 + syncsafe(b, 6));
    let o = 10;
    if (flags & 0x40) o += ver === 4 ? syncsafe(b, o) : u32(b, o) + 4;   // расширенный заголовок

    let best = null;
    while (o + (ver === 2 ? 6 : 10) <= tagEnd) {
      let id, size, head;
      if (ver === 2) { id = ascii(b, o, 3); size = u24(b, o + 3); head = 6; }
      else { id = ascii(b, o, 4); size = ver === 4 ? syncsafe(b, o + 4) : u32(b, o + 4); head = 10; }
      if (!/^[A-Z0-9]{3,4}$/.test(id) || size <= 0) break;   // дошли до паддинга
      const start = o + head, end = Math.min(start + size, tagEnd);

      if (id === 'APIC' || id === 'PIC') {
        const enc = b[start];
        let p = start + 1, mime = '';
        if (id === 'PIC') { mime = 'image/' + ascii(b, p, 3).toLowerCase().replace('jpg', 'jpeg'); p += 3; }
        else { const e = skipString(b, p, end, 0); mime = ascii(b, p, e - 1 - p); p = e; }
        const picType = b[p]; p += 1;
        p = skipString(b, p, end, enc);
        if (p < end) {
          const bytes = b.slice(p, end);
          const pic = { mime: sniff(bytes, mime), bytes, type: picType };
          if (picType === 3) return pic;                 // 3 = лицевая обложка
          if (!best) best = pic;
        }
      }
      o = end;
    }
    return best;
  }

  function fromFlac(b) {
    if (b.length < 8 || ascii(b, 0, 4) !== 'fLaC') return null;
    let o = 4, best = null;
    while (o + 4 <= b.length) {
      const last = b[o] & 0x80, type = b[o] & 0x7f, len = u24(b, o + 1);
      const s = o + 4;
      if (type === 6 && s + 32 <= b.length) {
        let p = s;
        const picType = u32(b, p); p += 4;
        const ml = u32(b, p); p += 4;
        const mime = ascii(b, p, ml); p += ml;
        const dl = u32(b, p); p += 4 + dl;
        p += 16;                                         // ширина, высота, глубина, палитра
        const n = u32(b, p); p += 4;
        const bytes = b.slice(p, Math.min(p + n, b.length));
        const pic = { mime: sniff(bytes, mime), bytes, type: picType };
        if (picType === 3) return pic;
        if (!best) best = pic;
      }
      if (last) break;
      o = s + len;
    }
    return best;
  }

  /** MP4: moov › udta › meta › ilst › covr › data. */
  function fromMp4(b) {
    if (b.length < 12 || ascii(b, 4, 4) !== 'ftyp') return null;
    const PATH = ['moov', 'udta', 'meta', 'ilst', 'covr', 'data'];
    function walk(o, end, depth) {
      while (o + 8 <= end) {
        let size = u32(b, o);
        const type = ascii(b, o + 4, 4);
        let head = 8;
        if (size === 1) { size = u32(b, o + 12) + u32(b, o + 8) * 4294967296; head = 16; }
        else if (size === 0) size = end - o;
        if (size < head) return null;
        const boxEnd = Math.min(o + size, end);
        if (type === PATH[depth]) {
          if (type === 'data') {
            const bytes = b.slice(o + head + 8, boxEnd);     // 4 байта типа + 4 байта локали
            return { mime: sniff(bytes), bytes, type: 3 };
          }
          const inner = o + head + (type === 'meta' ? 4 : 0); // meta — FullBox
          const r = walk(inner, boxEnd, depth + 1);
          if (r) return r;
        }
        o = boxEnd;
      }
      return null;
    }
    return walk(0, b.length, 0);
  }

  /* ---------- теги: исполнитель и название ---------- */

  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  function decode(bytes, enc) {
    const td = (label) => { try { return new TextDecoder(label).decode(bytes); } catch (e) { return null; } };
    if (enc === 1) return td('utf-16') || '';          // с BOM
    if (enc === 2) return td('utf-16be') || '';
    if (enc === 3) return td('utf-8') || '';
    // ISO-8859-1 по стандарту, но русские файлы почти всегда пишут туда CP1251
    let hi = 0, cyr = 0;
    for (const x of bytes) { if (x >= 0x80) hi++; if (x >= 0xc0) cyr++; }
    if (hi && cyr / hi > 0.6) { const s = td('windows-1251'); if (s) return s; }
    return td('latin1') || String.fromCharCode.apply(null, bytes);
  }

  const cleanTag = (s) => String(s || '').replace(/\0+$/g, '').split('\0').filter(Boolean).join(', ').trim();

  function tagsId3(b) {
    if (b.length < 10 || ascii(b, 0, 3) !== 'ID3') return null;
    const ver = b[3], flags = b[5];
    const tagEnd = Math.min(b.length, 10 + syncsafe(b, 6));
    let o = 10;
    if (flags & 0x40) o += ver === 4 ? syncsafe(b, o) : u32(b, o) + 4;
    const out = {};
    const want = ver === 2 ? { TT2: 'title', TP1: 'artist' } : { TIT2: 'title', TPE1: 'artist' };
    while (o + (ver === 2 ? 6 : 10) <= tagEnd) {
      let id, size, head;
      if (ver === 2) { id = ascii(b, o, 3); size = u24(b, o + 3); head = 6; }
      else { id = ascii(b, o, 4); size = ver === 4 ? syncsafe(b, o + 4) : u32(b, o + 4); head = 10; }
      if (!/^[A-Z0-9]{3,4}$/.test(id) || size <= 0) break;
      const start = o + head, end = Math.min(start + size, tagEnd);
      if (want[id] && end > start + 1) {
        let body = b.subarray(start + 1, end);
        if (b[start] === 1 || b[start] === 2) {
          // UTF-16: двойные нули-разделители значений
          out[want[id]] = cleanTag(decode(body, b[start]).replace(/﻿/g, ''));
        } else {
          out[want[id]] = cleanTag(decode(body, b[start]));
        }
      }
      o = end;
    }
    return out.title || out.artist ? out : null;
  }

  function tagsId3v1(b) {
    if (b.length < 128) return null;
    const o = b.length - 128;
    if (ascii(b, o, 3) !== 'TAG') return null;
    const field = (p, n) => cleanTag(decode(b.subarray(p, p + n), 0).replace(/\0.*$/, '')).trim();
    const out = { title: field(o + 3, 30), artist: field(o + 33, 30) };
    return out.title || out.artist ? out : null;
  }

  function tagsFlac(b) {
    if (b.length < 8 || ascii(b, 0, 4) !== 'fLaC') return null;
    let o = 4;
    while (o + 4 <= b.length) {
      const last = b[o] & 0x80, type = b[o] & 0x7f, len = u24(b, o + 1), s = o + 4;
      if (type === 4) {
        let p = s;
        p += 4 + le32(b, p);                    // vendor
        const n = le32(b, p); p += 4;
        const out = {}, artists = [];
        const td = new TextDecoder('utf-8');
        for (let i = 0; i < n && p + 4 <= s + len; i++) {
          const l = le32(b, p); p += 4;
          const kv = td.decode(b.subarray(p, p + l)); p += l;
          const eq = kv.indexOf('=');
          if (eq < 0) continue;
          const k = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1).trim();
          if (k === 'TITLE' && !out.title) out.title = v;
          if (k === 'ARTIST' && v) artists.push(v);
        }
        if (artists.length) out.artist = artists.join(', ');
        return out.title || out.artist ? out : null;
      }
      if (last) break;
      o = s + len;
    }
    return null;
  }

  function tagsMp4(b) {
    if (b.length < 12 || ascii(b, 4, 4) !== 'ftyp') return null;
    const out = {};
    const NAM = '©nam', ART = '©ART';
    function walk(o, end, depth) {
      while (o + 8 <= end) {
        let size = u32(b, o);
        const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
        if (size === 0) size = end - o;
        if (size < 8) return;
        const boxEnd = Math.min(o + size, end);
        const path = ['moov', 'udta', 'meta', 'ilst'];
        if (depth < 4 && type === path[depth]) walk(o + 8 + (type === 'meta' ? 4 : 0), boxEnd, depth + 1);
        else if (depth === 4 && (type === NAM || type === ART)) {
          // внутри — атом data: 8 заголовок + 4 тип + 4 локаль + UTF-8
          const d = o + 8;
          if (ascii(b, d + 4, 4) === 'data') {
            const v = new TextDecoder('utf-8').decode(b.subarray(d + 16, Math.min(d + u32(b, d), boxEnd))).trim();
            if (type === NAM) out.title = v; else out.artist = v;
          }
        }
        o = boxEnd;
      }
    }
    walk(0, b.length, 0);
    return out.title || out.artist ? out : null;
  }

  /** { title, artist } из тегов файла или null. */
  function tagsOf(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try { return tagsId3(b) || tagsFlac(b) || tagsMp4(b) || tagsId3v1(b); } catch (e) { return null; }
  }

  async function tagsOfBlob(blob) {
    try { return tagsOf(new Uint8Array(await blob.arrayBuffer())); } catch (e) { return null; }
  }

  function extract(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try { return fromId3(b) || fromFlac(b) || fromMp4(b); } catch (e) { return null; }
  }

  /** Уменьшенная копия обложки как data: URL — её можно передать странице одним сообщением. */
  async function thumbnail(pic, size) {
    size = size || 300;
    const blob = new Blob([pic.bytes], { type: pic.mime });
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, size / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    // в service worker нет document — там рисуем на OffscreenCanvas
    if (typeof document === 'undefined' && typeof OffscreenCanvas === 'function') {
      const oc = new OffscreenCanvas(w, h);
      oc.getContext('2d').drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      const out = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      return await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(out);
      });
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return c.toDataURL('image/jpeg', 0.85);
  }

  /** Обложка файла из библиотеки как data: URL или null. */
  async function coverOf(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const pic = extract(buf);
    if (!pic || !pic.bytes.length) return null;
    try { return await thumbnail(pic); } catch (e) { return null; }
  }

  const api = { extract, coverOf, thumbnail, tagsOf, tagsOfBlob };
  root.YMUCover = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

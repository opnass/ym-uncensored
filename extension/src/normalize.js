/* normalize.js — общая нормализация имён и скоринг совпадений.
   Загружается в options/popup (extension origin) и в SW. В content script не нужен. */
(function (root) {
  'use strict';

  const VERSION_MARKERS = /(?:explicit|uncensored|uncesored|dirty|clean|censored|remaster(?:ed)?|deluxe|radio edit|album version|версия|цензур|без мата|нецензурн)/i;

  /** Приводит строку к сравнимому виду: нижний регистр, ё→е, без пунктуации и версионных хвостов. */
  function norm(input) {
    if (input == null) return '';
    let t = String(input).toLowerCase().replace(/ё/g, 'е');
    t = t.replace(/[’'`´]/g, '');
    // выкидываем скобочные уточнения, если внутри есть маркер версии
    t = t.replace(/\(([^)]*)\)/g, (m, inner) => (VERSION_MARKERS.test(inner) ? ' ' : ' ' + inner + ' '));
    t = t.replace(/\[([^\]]*)\]/g, (m, inner) => (VERSION_MARKERS.test(inner) ? ' ' : ' ' + inner + ' '));
    // feat./ft. и всё после
    t = t.replace(/\b(?:feat|ft|при\s+уч)\.?\s+[^,;–—-]+/gi, ' ');
    t = t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return t;
  }

  /** Является ли объект трека помеченным как explicit (несколько возможных сигналов API). */
  function isExplicit(track) {
    if (!track) return false;
    const cw = track.contentWarning || track.content_warning;
    if (typeof cw === 'string' && /explicit|18/i.test(cw)) return true;
    if (track.explicit === true) return true;
    const hay = [track.title, track.version, track.album, track.subtitle]
      .filter(Boolean).join(' ');
    return /\(explicit\)|\[explicit\]|\bexplicit\b|нецензурн|без цензуры/i.test(hay);
  }

  /** Стабильный ключ трека: нормализованные артисты + название. */
  function trackKey(title, artists) {
    const a = (Array.isArray(artists) ? artists.join(' ') : (artists || ''));
    return norm(a) + '|' + norm(title);
  }

  function bigrams(s) {
    const out = new Map();
    const clean = s.replace(/\s+/g, '');
    for (let i = 0; i < clean.length - 1; i++) {
      const g = clean.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  }

  /** Коэффициент Дайса по биграммам, 0..1. */
  function dice(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    const A = bigrams(a), B = bigrams(b);
    let inter = 0, total = 0;
    for (const [g, n] of A) { total += n; if (B.has(g)) inter += Math.min(n, B.get(g)); }
    for (const [, n] of B) total += n;
    return total ? (2 * inter) / total : 0;
  }

  /** Сравнение двух треков: 0..1 с учётом длительности. */
  function score(candidate, target) {
    const titleS = dice(norm(candidate.title), norm(target.title));
    const artistS = dice(norm(candidate.artists), norm(target.artists));
    let s = 0.62 * titleS + 0.38 * artistS;
    if (candidate.durationMs && target.durationMs) {
      const diff = Math.abs(candidate.durationMs - target.durationMs) / 1000;
      // explicit-версия обычно длиннее цензурной, поэтому небольшая разница — норма
      if (diff <= 3) s += 0.08;
      else if (diff <= 8) s += 0.03;
      else if (diff <= 20) s += 0;
      else if (diff <= 40) s -= 0.10;
      else s -= 0.35;
    }
    return Math.max(0, Math.min(1, s));
  }

  /** Строка «исполнитель название» целиком — для файлов, где исполнитель не отделён
      («Мукка Таблетка.mp3»). Порядок не важен: берём лучшее из двух. */
  function scoreLoose(candidate, target) {
    const c = norm([candidate.artists, candidate.title].filter(Boolean).join(' '));
    const a = norm([target.artists, target.title].filter(Boolean).join(' '));
    const b = norm([target.title, target.artists].filter(Boolean).join(' '));
    let s = Math.max(dice(c, a), dice(c, b)) - 0.04;    // чуть строже обычного: структуры нет
    if (candidate.durationMs && target.durationMs) {
      const diff = Math.abs(candidate.durationMs - target.durationMs) / 1000;
      if (diff <= 3) s += 0.08;
      else if (diff <= 8) s += 0.03;
      else if (diff > 40) s -= 0.35;
      else if (diff > 20) s -= 0.10;
    }
    return Math.max(0, Math.min(1, s));
  }

  const api = { norm, isExplicit, trackKey, dice, score, scoreLoose, VERSION_MARKERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.YMU = Object.assign(root.YMU || {}, api);
})(typeof self !== 'undefined' ? self : globalThis);

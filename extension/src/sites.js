/* sites.js — где искать explicit-версию трека. Общий для попапа и настроек.
   Только официальные магазины, где трек можно купить файлом. Пользователь сам
   включает нужные, выбирает основной и может добавить свой сайт по шаблону {q}. */
(function (root) {
  'use strict';

  const DEFAULT_SITES = [
    { id: 'bandcamp', name: 'Bandcamp', url: 'https://bandcamp.com/search?q={q}&item_type=t', enabled: true },
    { id: 'itunes', name: 'Apple / iTunes', url: 'https://music.apple.com/search?term={q}', enabled: true },
    { id: 'qobuz', name: 'Qobuz', url: 'https://www.qobuz.com/us-en/search?q={q}', enabled: true },
    { id: '7digital', name: '7digital', url: 'https://us.7digital.com/search?q={q}', enabled: false },
    { id: 'amazon', name: 'Amazon Music', url: 'https://www.amazon.com/s?k={q}&i=digital-music', enabled: false },
    { id: 'beatport', name: 'Beatport', url: 'https://www.beatport.com/search?q={q}', enabled: false },
  ];

  /** Пометки сайтов-источников и цензуры мешают поиску в магазине — убираем их. */
  function cleanQuery(track) {
    const strip = (s) => String(s || '')
      .replace(/\(\s*(?:[\w-]+\.)+[a-z]{2,6}\s*\)/gi, ' ')                       // (hitmo.net)
      .replace(/[([]\s*(?:clean|censored|radio edit|edited|explicit)[^)\]]*[)\]]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return [strip(track && track.artists), strip(track && track.title)].filter(Boolean).join(' ');
  }

  function buildUrl(site, track) {
    const q = encodeURIComponent(cleanQuery(track));
    return String(site.url || '').replace(/\{q\}/g, q);
  }

  /** Ссылка с шаблоном должна быть http(s) и содержать {q}. */
  function validTemplate(url) {
    return /^https?:\/\/[^\s]+$/i.test(String(url || '')) && String(url).includes('{q}');
  }

  /** Сохранённый список сайтов + новые встроенные, которых в нём ещё нет. */
  async function load(db) {
    let saved = null;
    try { saved = await db.getSetting('searchSites', null); } catch (e) { saved = null; }
    const list = Array.isArray(saved) ? saved.slice() : DEFAULT_SITES.map((s) => Object.assign({}, s));
    for (const d of DEFAULT_SITES) {
      // встроенные сайты не удаляются, только выключаются — поэтому недостающий значит новый
      if (!list.some((s) => s.id === d.id)) {
        list.push(Object.assign({}, d));
      }
    }
    let def = null;
    try { def = await db.getSetting('searchDefault', null); } catch (e) { def = null; }
    if (!list.some((s) => s.id === def && s.enabled)) {
      const first = list.find((s) => s.enabled);
      def = first ? first.id : null;
    }
    return { sites: list, defaultId: def };
  }

  async function save(db, sites, defaultId) {
    await db.setSetting('searchSites', sites.map((s) => ({ id: s.id, name: s.name, url: s.url, enabled: !!s.enabled, custom: !!s.custom })));
    await db.setSetting('searchDefault', defaultId || null);
  }

  /** Включённые сайты, основной — первым. */
  function ordered(state) {
    const on = state.sites.filter((s) => s.enabled);
    return on.sort((a, b) => (a.id === state.defaultId ? -1 : b.id === state.defaultId ? 1 : 0));
  }

  const api = { DEFAULT_SITES, cleanQuery, buildUrl, validTemplate, load, save, ordered };
  root.YMUSites = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

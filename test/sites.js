/* Где искать explicit-версии: очистка запроса, ссылки, хранение настроек. */
'use strict';
const S = require(require('path').join(__dirname, '..', 'extension', 'src', 'sites.js'));
let bad = 0;
const t = (n, c, extra) => { if (!c) bad++; console.log((c ? '  OK    ' : '  FAIL  ') + n + (c || extra === undefined ? '' : ' → ' + extra)); };

function db() {
  const m = new Map();
  return { getSetting: async (k, d) => (m.has(k) ? m.get(k) : d), setSetting: async (k, v) => void m.set(k, v), m };
}

(async () => {
  console.log('\n[1] запрос для магазина');
  t('метка сайта-источника убрана', S.cleanQuery({ artists: 'Face', title: 'Мой Калашников (hitmo.net)' }) === 'Face Мой Калашников',
    S.cleanQuery({ artists: 'Face', title: 'Мой Калашников (hitmo.net)' }));
  t('пометки цензуры убраны', S.cleanQuery({ artists: 'МУККА', title: 'Таблетка (Clean Version)' }) === 'МУККА Таблетка');
  t('[Radio Edit] убран', S.cleanQuery({ artists: 'A', title: 'Song [Radio Edit]' }) === 'A Song');
  t('значимые скобки остаются', S.cleanQuery({ artists: 'A', title: 'Song (prod. by X)' }) === 'A Song (prod. by X)');
  t('без артиста — только название', S.cleanQuery({ title: 'Таблетка' }) === 'Таблетка');

  console.log('\n[2] ссылка');
  const url = S.buildUrl({ url: 'https://bandcamp.com/search?q={q}&item_type=t' }, { artists: 'МУККА', title: 'Таблетка' });
  t('запрос закодирован в {q}', url === 'https://bandcamp.com/search?q=' + encodeURIComponent('МУККА Таблетка') + '&item_type=t', url);
  const amp = S.buildUrl({ url: 'https://x.com/?q={q}&t=1' }, { title: 'A & B #1' });
  t('& и # в названии не ломают ссылку', amp === 'https://x.com/?q=A%20%26%20B%20%231&t=1', amp);
  t('все встроенные сайты — https и с {q}', S.DEFAULT_SITES.every((s) => S.validTemplate(s.url)));
  t('шаблон без {q} отклонён', !S.validTemplate('https://example.com/search'));
  t('javascript: отклонён', !S.validTemplate('javascript:alert(1)//{q}'));

  console.log('\n[3] хранение');
  const d = db();
  let st = await S.load(d);
  t('по умолчанию — встроенные сайты', st.sites.length === S.DEFAULT_SITES.length);
  t('основной — первый включённый', st.defaultId === 'bandcamp', st.defaultId);
  st.sites.find((s) => s.id === 'bandcamp').enabled = false;
  st.sites.push({ id: 'custom-1', name: 'Мой', url: 'https://my.shop/?q={q}', enabled: true, custom: true });
  await S.save(d, st.sites, 'custom-1');
  st = await S.load(d);
  t('выключенный сайт остаётся выключенным', st.sites.find((s) => s.id === 'bandcamp').enabled === false);
  t('свой сайт сохранён', st.sites.some((s) => s.id === 'custom-1' && s.custom));
  t('основной — свой сайт', st.defaultId === 'custom-1');
  t('основной идёт первым', S.ordered(st)[0].id === 'custom-1');
  t('выключенные не показываются', !S.ordered(st).some((s) => s.id === 'bandcamp'));
  await S.save(d, st.sites.map((s) => Object.assign(s, { enabled: s.id === 'qobuz' })), 'custom-1');
  st = await S.load(d);
  t('основной выключен → основным становится включённый', st.defaultId === 'qobuz', st.defaultId);

  console.log('\n' + (bad ? 'ПРОВАЛОВ: ' + bad : 'Все проверки пройдены'));
  process.exit(bad ? 1 : 0);
})();

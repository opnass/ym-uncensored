/* Unit-тесты нормализации и матчера. Связку слоёв проверяет test/integration.js.
   Здесь только чистая логика — без стабов браузера. */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'extension', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('  OK    ' + name);
  else { fails++; console.log('  FAIL  ' + name + (extra ? ' → ' + extra : '')); }
}

const YMU = new Function('self', 'module', read('normalize.js') + '\nreturn self.YMU;')({}, {});
console.log('[1] normalize.js загружен:', !!YMU);

/* ---------- нормализация ---------- */

console.log('\n[2] ключ трека: версии и скобки схлопываются');
const keyCases = [
  ['МУККА', 'Таблетка', 'мукка|таблетка'],
  ['МУККА', 'Таблетка (Explicit)', 'мукка|таблетка'],
  ['МУККА', 'Таблетка [Explicit Version]', 'мукка|таблетка'],
  ['МУККА', 'Таблетка (Remastered 2011)', 'мукка|таблетка'],
  ['Anacondaz', 'Мама, я люблю...', 'anacondaz|мама я люблю'],
  ['Ёлка', 'Прованс', 'елка|прованс'],
  ['Скриптонит', 'Положение (feat. 104)', 'скриптонит|положение'],
];
for (const [artist, title, expected] of keyCases) {
  const got = YMU.trackKey(title, artist);
  check(`${artist} — ${title}`, got === expected, `"${got}" вместо "${expected}"`);
}

console.log('\n[3] значимые скобки НЕ выкидываются');
const keepCases = [
  ['МУККА', 'Платина (prod. by X)'],
  ['Artist', 'Track [Bonus Track]'],
  ['Artist', 'Track (Live)'],
];
for (const [artist, title] of keepCases) {
  const k = YMU.trackKey(title, artist);
  const tail = k.split('|')[1];
  const words = title.toLowerCase().replace(/[[\]()]/g, ' ').split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !['by', 'x'].includes(w));
  const kept = meaningful.some((w) => tail.includes(w));
  check(`${title} → "${tail}"`, kept, 'содержимое скобок потерялось');
}

console.log('\n[4] isExplicit');
check('contentWarning=explicit', YMU.isExplicit({ contentWarning: 'explicit' }));
check('(Explicit) в названии', YMU.isExplicit({ title: 'Трек (Explicit)' }));
check('обычный трек не explicit', !YMU.isExplicit({ title: 'Таблетка', contentWarning: '' }));

/* ---------- матчер ---------- */

console.log('\n[5] скоринг');
const scoreCases = [
  ['точное совпадение', { title: 'Таблетка', artists: 'МУККА', durationMs: 175000 },
    { title: 'Таблетка', artists: 'МУККА', durationMs: 176000 }, '>', 0.9],
  ['(Explicit) в файле', { title: 'Таблетка (Explicit)', artists: 'МУККА', durationMs: 175000 },
    { title: 'Таблетка', artists: 'МУККА', durationMs: 175000 }, '>', 0.9],
  ['Explicit Version', { title: 'Девочка с каре (Explicit Version)', artists: 'МУККА', durationMs: 201000 },
    { title: 'Девочка с каре', artists: 'МУККА', durationMs: 200000 }, '>', 0.9],
  ['чужой трек того же артиста', { title: 'Девочка с каре', artists: 'МУККА', durationMs: 200000 },
    { title: 'Таблетка', artists: 'МУККА', durationMs: 175000 }, '<', 0.6],
  ['титул совпал, длина 90 сек', { title: 'Таблетка', artists: 'МУККА', durationMs: 90000 },
    { title: 'Таблетка', artists: 'МУККА', durationMs: 175000 }, '<', 0.82],
  ['без артиста в имени файла', { title: 'Таблетка', artists: '', durationMs: 175000 },
    { title: 'Таблетка', artists: 'МУККА', durationMs: 175000 }, '<', 0.82],
];
for (const [label, a, b, op, threshold] of scoreCases) {
  const s = YMU.score(a, b);
  const ok = op === '>' ? s > threshold : s < threshold;
  check(`${label} (${s.toFixed(2)} ${op} ${threshold})`, ok);
}

console.log('\n[6] имена файлов');
const parseName = (fn) => {
  const base = fn.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const p = base.split(/\s+[-–—]\s+/);
  return p.length >= 2
    ? { artists: p[0].trim(), title: p.slice(1).join(' - ').trim() }
    : { artists: '', title: base };
};
const nameCases = [
  ['МУККА - Таблетка.mp3', 'МУККА', 'Таблетка'],
  ['Anacondaz - Мама, я люблю....mp3', 'Anacondaz', 'Мама, я люблю...'],
  ['Скриптонит - Положение (feat. 104).mp3', 'Скриптонит', 'Положение (feat. 104)'],
];
for (const [fn, wantArtist, wantTitle] of nameCases) {
  const p = parseName(fn);
  check(`${fn}`, p.artists === wantArtist && p.title === wantTitle,
    JSON.stringify(p));
}

console.log('\n' + '='.repeat(52));
console.log(fails ? `ПРОВАЛОВ: ${fails}` : 'Все проверки пройдены');
process.exit(fails ? 1 : 0);

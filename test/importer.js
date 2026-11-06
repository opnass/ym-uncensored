/* Автоимпорт скачанного: очередь, поиск в папке, дубликаты, доступ к папке. */
'use strict';
const path = require('path');
const SRC = path.join(__dirname, '..', 'extension', 'src');
require(path.join(SRC, 'normalize.js'));
const I = require(path.join(SRC, 'importer.js'));
let bad = 0;
const t = (n, c, extra) => { if (!c) bad++; console.log((c ? '  OK    ' : '  FAIL  ') + n + (c || extra === undefined ? '' : ' → ' + extra)); };

function db() {
  const files = new Map(), s = new Map();
  return {
    putFile: async (r) => void files.set(r.id, r), allFiles: async () => [...files.values()],
    getSetting: async (k, d) => (s.has(k) ? s.get(k) : d), setSetting: async (k, v) => void s.set(k, v), files, s,
  };
}
/** Папка File System Access: { 'a.mp3': File, sub: { ... } } */
function dir(tree, name, perm) {
  const state = { perm: perm || 'granted', asked: 0 };
  const h = {
    kind: 'directory', name: name || 'Downloads', state,
    async *entries() {
      for (const [n, v] of Object.entries(tree)) {
        if (v instanceof File) yield [n, { kind: 'file', getFile: async () => v }];
        else yield [n, dir(v, n, state.perm)];
      }
    },
    queryPermission: async () => state.perm,
    requestPermission: async () => { state.asked++; state.perm = state.grantOnAsk ? 'granted' : state.perm; return state.perm; },
  };
  return h;
}
const mp3 = (name, size) => new File([Buffer.alloc(size || 10)], name, { type: 'audio/mpeg' });

(async () => {
  console.log('\n[1] что считать аудио');
  t('mp3/m4a/flac/opus — да', ['a.mp3', 'b.M4A', 'c.flac', 'd.opus'].every((n) => I.isAudio(n)));
  t('zip/exe/pdf — нет', !['a.zip', 'b.exe', 'c.pdf'].some((n) => I.isAudio(n)));
  t('по mime audio/* — да', I.isAudio('download', 'audio/mpeg'));
  t('basename из пути Windows', I.basename('C:\\Users\\me\\Downloads\\МУККА - Таблетка.mp3') === 'МУККА - Таблетка.mp3');

  console.log('\n[2] запись библиотеки');
  const rec = await I.makeRecord(mp3('МУККА - Таблетка (Explicit).mp3', 20), { source: 'download' });
  t('исполнитель и название из имени', rec.artists === 'МУККА' && rec.title === 'Таблетка (Explicit)');
  t('ключ совпадает с ключом трека Яндекса', rec.key === 'мукка|таблетка', rec.key);
  t('без длительности — пометка дочитать', rec.durationMs === 0 && rec.durationChecked === false);
  t('источник записан', rec.source === 'download');

  console.log('\n[3] очередь скачанного → библиотека');
  const d = db();
  const A = mp3('Face - Трек.mp3', 30), B = mp3('Кто-то - Второй.mp3', 40);
  await d.setSetting('importDir', dir({ 'Face - Трек.mp3': A, Музыка: { 'Кто-то - Второй.mp3': B } }));
  await d.setSetting('importQueue', [
    { id: 1, name: 'Face - Трек.mp3', size: 30, at: Date.now() },
    { id: 2, name: 'Кто-то - Второй.mp3', size: 40, at: Date.now() },
    { id: 3, name: 'Нет такого.mp3', size: 5, at: Date.now() },
  ]);
  let res = await I.processQueue(d);
  t('импортированы оба файла, в том числе из подпапки', res.imported.length === 2, JSON.stringify(res.imported.map((r) => r.name)));
  t('пропавший файл — в «не найдено»', res.notFound.length === 1);
  t('пропавший свежий файл остаётся в очереди', res.left === 1);
  await d.setSetting('importQueue', [{ id: 1, name: 'Face - Трек.mp3', size: 30, at: Date.now() }]);
  res = await I.processQueue(d);
  t('повторная загрузка того же файла — не дубль', res.imported.length === 0 && res.skipped.length === 1);
  t('в библиотеке два файла', d.files.size === 2);

  console.log('\n[4] тот же размер — другой файл с тем же именем не подменяет');
  const d2 = db();
  await d2.setSetting('importDir', dir({ 'x.mp3': mp3('x.mp3', 99) }));
  await d2.setSetting('importQueue', [{ id: 9, name: 'x.mp3', size: 10, at: Date.now() }]);
  res = await I.processQueue(d2);
  t('размер не совпал — файл не взят', res.imported.length === 0 && res.notFound.length === 1);

  console.log('\n[5] доступ к папке');
  const d3 = db();
  const locked = dir({ 'a.mp3': mp3('a.mp3') }, 'Downloads', 'prompt');
  await d3.setSetting('importDir', locked);
  await d3.setSetting('importQueue', [{ id: 1, name: 'a.mp3', size: 10, at: Date.now() }]);
  res = await I.processQueue(d3, { ask: false });
  t('без клика доступ не спрашиваем', res.needPermission && locked.state.asked === 0);
  t('очередь сохранена', (await d3.getSetting('importQueue', [])).length === 1);
  locked.state.grantOnAsk = true;
  res = await I.processQueue(d3, { ask: true });
  t('с кликом — спросили и импортировали', locked.state.asked === 1 && res.imported.length === 1);
  const d4 = db();
  await d4.setSetting('importQueue', [{ id: 1, name: 'a.mp3', size: 10, at: Date.now() }]);
  res = await I.processQueue(d4);
  t('папка не выбрана — так и говорит', res.noFolder === true && res.left === 1);

  console.log('\n[6] сканирование папки');
  const d5 = db();
  await d5.setSetting('importDir', dir({ 'a.mp3': mp3('a.mp3', 1), 'b.txt': new File(['x'], 'b.txt'), s: { 'c.flac': new File([Buffer.alloc(3)], 'c.flac') } }));
  res = await I.scanFolder(d5);
  t('взяты только аудио, включая подпапки', res.imported.length === 2, JSON.stringify(res.imported.map((r) => r.name)));
  res = await I.scanFolder(d5);
  t('повторное сканирование ничего не дублирует', res.imported.length === 0 && res.skipped === 2);

  console.log('\n' + (bad ? 'ПРОВАЛОВ: ' + bad : 'Все проверки пройдены'));
  process.exit(bad ? 1 : 0);
})();

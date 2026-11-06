/* Интеграционный харнесс: inject.js (MAIN) + bridge.js (ISOLATED) + background.js (SW).

   Три регресса, которые обязан ловить этот файл:

   (1) 0.2.0 — страница не должна зависеть от window.YMU, иначе inject делает
       ранний return и трек не определяется.

   (2) 0.4.0 — плеер не держит медиа в DOM (querySelector('audio') === null),
       поэтому элемент ловится реестром: createElement / new Audio / play.

   (3) 0.5.0 — Яндекс отдаёт зашифрованный поток (transport: encraw, music-v2/crypt)
       и сам расшифровывает его в JS, присваивая элементу СВОЙ blob:. Любая
       подмена src вступает с плеером в гонку и ломает воспроизведение трека.
       Поэтому src плеера трогать НЕЛЬЗЯ: играем параллельную копию. */
'use strict';

const fs = require('fs');
const path = require('path');

const log = console.log.bind(console);
const REAL_CONSOLE = globalThis.console;

const SRC = path.join(__dirname, '..', 'extension', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

let fails = 0;
function check(name, cond, extra) {
  if (cond) log('  OK    ' + name);
  else { fails++; log('  FAIL  ' + name + (extra ? ' → ' + extra : '')); }
}

function finish() {
  globalThis.console = REAL_CONSOLE;
  log('\n' + '='.repeat(58));
  log(fails ? `ПРОВАЛОВ: ${fails}` : 'Все проверки пройдены');
  process.exit(fails ? 1 : 0);
}

/* ============ 1. статические инварианты ============ */

log('\n[1] страница не зависит от нормализации (регресс 0.2.0)');
const injectRaw = read('inject.js');
const bridgeRaw = read('bridge.js');
const injectCode = stripComments(injectRaw);
const bridgeCode = stripComments(bridgeRaw);

check('inject.js не читает window.YMU', !/window\.YMU/.test(injectCode));
check('bridge.js не читает window.YMU', !/window\.YMU/.test(bridgeCode));

const manifest = JSON.parse(read('../manifest.json'));
const csAll = (manifest.content_scripts || []).flatMap((s) => s.js || []);
check('normalize.js не грузится в content_scripts',
  !csAll.some((f) => f.includes('normalize.js')), csAll.join(', '));

log('\n[2] плеер ловится реестром (регресс 0.4.0)');
check('перехвачен document.createElement', /Document\.prototype\.createElement\s*=/.test(injectCode));
check('перехвачен new Audio()', /window\.Audio\s*=/.test(injectCode));
check('перехвачен play()', /HTMLMediaElement\.prototype\.play\s*=/.test(injectCode));

log('\n[3] src плеера НЕ подменяется (регресс 0.5.0)');
check('нет перехвата сеттера src у медиаэлемента',
  !/defineProperty\(HTMLMediaElement\.prototype,\s*'src'/.test(injectCode));
check('нет подмены атрибута src через setAttribute',
  !/setAttribute\s*=\s*function/.test(injectCode));
check('есть параллельное воспроизведение', /function ensureShadow|__ymuOwn/.test(injectCode));
check('плеер глушится', /\.muted\s*=\s*true/.test(injectCode) || /muted = true/.test(injectCode));

/* ============ 2. песочница ============ */

function makeDb() {
  const files = new Map(), bindings = new Map(), settings = new Map(), capture = [];
  return {
    putFile: async (r) => void files.set(r.id, r),
    getFile: async (id) => files.get(id) || null,
    allFiles: async () => [...files.values()],
    deleteFile: async (id) => void files.delete(id),
    putBinding: async (b) => void bindings.set(b.key, b),
    getBinding: async (k) => bindings.get(k) || null,
    allBindings: async () => [...bindings.values()],
    deleteBinding: async (k) => void bindings.delete(k),
    getSetting: async (k, d) => (settings.has(k) ? settings.get(k) : d),
    setSetting: async (k, v) => void settings.set(k, v),
    allSettings: async () => Object.fromEntries(settings),
    pushCapture: async (r) => void capture.push(r),
    allCapture: async () => capture,
    clearCapture: async () => void capture.splice(0),
    __raw: { files, bindings, settings, capture },
  };
}

function bootServiceWorker(db, extra) {
  const listeners = [];
  const importScripts = (...paths) => {
    for (const p of paths) {
      if (p.includes('normalize.js')) {
        new Function('self', 'module', read('normalize.js') + '\n').call(globalThis, globalThis, {});
      } else if (p.includes('db.js')) {
        globalThis.YMUDB = db;
      } else if (p.includes('cover.js') || p.includes('importer.js')) {
        new Function('self', 'module', read(p) + '\n').call(globalThis, globalThis, {});
      }
    }
  };
  const chromeStub = {
    runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, lastError: null },
    tabs: { query: (q, cb) => cb([]), sendMessage: () => Promise.resolve() },
  };
  if (extra && extra.downloads) chromeStub.downloads = extra.downloads;
  chromeStub.action = { setBadgeText: (o) => { chromeStub.__badge = o.text; }, setBadgeBackgroundColor() {} };
  chromeStub.runtime.sendMessage = () => Promise.resolve();
  extra && (extra.chrome = chromeStub);
  const prevIS = globalThis.importScripts;
  globalThis.importScripts = importScripts;
  globalThis.chrome = chromeStub;
  new Function(read('background.js')).call(globalThis);
  globalThis.importScripts = prevIS;

  return {
    call(type, payload) {
      return new Promise((resolve) => {
        let answered = false;
        const done = (v) => { if (!answered) { answered = true; resolve(v); } };
        for (const fn of listeners) fn({ type, payload }, {}, done);
        setTimeout(() => done(null), 800);
      });
    },
  };
}

/** Медиаэлемент: пишем класс сами, чтобы inject патчил именно его прототип. */
function makeMediaClass(state) {
  class Base {
    constructor() {
      this.tagName = 'AUDIO';
      this.__src = '';
      this.currentTime = 0;
      this.paused = true;
      this.playbackRate = 1;
      this.volume = 1;
      this.muted = false;
      this.duration = 175;
      this.readyState = 0;
      this.error = null;
      this.__listeners = {};
    }
    addEventListener(t, fn) { (this.__listeners[t] = this.__listeners[t] || []).push(fn); }
    removeEventListener(t, fn) {
      const arr = this.__listeners[t] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
    dispatchEvent(e) { (this.__listeners[e.type] || []).slice().forEach((f) => f(e)); return true; }
    emit(type) { this.dispatchEvent({ type }); }
    load() {}
    removeAttribute(name) { if (name === 'src') this.__src = ''; }
    play() {
      if (state && state.playFails) return Promise.reject(new Error('NotAllowedError'));
      if (state && state.decodeError) {
        this.error = { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' };
        (this.__listeners['error'] || []).forEach((f) => f());
        return Promise.resolve();
      }
      this.paused = false;
      this.readyState = 4;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    canPlayType() { return state && typeof state.canPlay === 'string' ? state.canPlay : 'probably'; }
  }
  Object.defineProperty(Base.prototype, 'src', {
    configurable: true,
    get() { return this.__src || ''; },
    set(v) { this.__src = v; },
  });
  return Base;
}

function makeDocument(createEl) {
  const body = { appendChild() {} };
  class Doc {
    constructor() {
      this.readyState = 'complete';
      this.title = 'Яндекс.Музыка';
      this.body = body;
      this.documentElement = body;
    }
    querySelector() { return null; }   // плеер не держит медиа в DOM
    querySelectorAll() { return []; }
    createElement(tag) {
      const t = String(tag).toLowerCase();
      if (t === 'audio' || t === 'video') return createEl();
      return {
        style: {}, isConnected: true,
        set innerHTML(v) { this._h = v; },
        get innerHTML() { return this._h; },
        appendChild() {},
        addEventListener() {},
      };
    }
    addEventListener() {}
  }
  return new Doc();
}

function bootStack(init) {
  const db = makeDb();
  if (init && init.settings) for (const [k, v] of Object.entries(init.settings)) db.__raw.settings.set(k, v);
  if (init && init.files) for (const f of init.files) db.__raw.files.set(f.id, f);

  const sw = bootServiceWorker(db);
  const mediaState = {
    playFails: !!(init && init.playFails),
    decodeError: !!(init && init.decodeError),
    canPlay: init && typeof init.canPlay === 'string' ? init.canPlay : 'probably',
  };
  const Base = makeMediaClass(mediaState);

  const created = [];
  const createEl = () => { const el = new Base(); created.push(el); return el; };
  const doc = makeDocument(createEl);

  const listeners = {};
  const win = {
    addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f),
    dispatchEvent: () => true,
    Audio: function () { return createEl(); },
  };
  win.Audio.prototype = Base.prototype;

  const chromeBridge = {
    runtime: {
      sendMessage: (msg) => sw.call(msg.type, msg.payload),
      onMessage: { addListener: (fn) => (chromeBridge.__swToPage = fn) },
    },
  };

  const prev = {
    window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    chrome: globalThis.chrome, HTMLMediaElement: globalThis.HTMLMediaElement,
    Element: globalThis.Element, Document: globalThis.Document,
    XMLHttpRequest: globalThis.XMLHttpRequest, console: globalThis.console,
    setInterval: globalThis.setInterval, CustomEvent: globalThis.CustomEvent,
    location: globalThis.location,
  };

  globalThis.HTMLMediaElement = Base;
  globalThis.Element = class { setAttribute() {} getAttribute() { return null; } };
  globalThis.Document = doc.constructor;
  globalThis.XMLHttpRequest = class { open() {} send() {} };
  globalThis.CustomEvent = class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } };
  globalThis.console = { info() {}, warn() {}, error() {}, log() {} };
  globalThis.location = { href: 'https://music.yandex.ru/' };
  globalThis.MediaMetadata = class { constructor(o) { Object.assign(this, o); } };

  globalThis.window = win;
  globalThis.document = doc;
  globalThis.chrome = chromeBridge;
  new Function(bridgeRaw).call(win);

  const toPage = listeners['ymu:to-page'] || (listeners['ymu:to-page'] = []);
  const toBridge = listeners['ymu:to-bridge'] || [];
  win.dispatchEvent = (e) => {
    if (e.type === 'ymu:to-page') { for (const f of toPage) f(e); return true; }
    if (e.type === 'ymu:to-bridge') { for (const f of toBridge) f(e); return true; }
    return true;
  };

  const intervals = [];
  // В Node 21+ navigator — глобальный геттер, обычное присваивание падает.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: (init && init.navigator) ||
      { mediaSession: { metadata: { title: 'Таблетка', artist: 'МУККА' } } },
  });
  globalThis.setInterval = (fn) => { intervals.push(fn); return intervals.length; };

  new Function(injectRaw).call(win);

  return { win, doc, db, sw, intervals, created, createEl };
}

const tick = (stack, times) => { for (let i = 0; i < (times || 1); i++) stack.intervals[0](); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============ 3. прогон ============ */

const FILE = {
  id: 'file-1', name: 'МУККА - Таблетка.mp3', title: 'Таблетка', artists: 'МУККА',
  key: 'мукка|таблетка', durationMs: 175000, size: 20, mime: 'audio/mpeg',
  blob: new Blob([Buffer.from('ID3fake-mp3-payload')], { type: 'audio/mpeg' }),
};

/** Плеер: создал элемент, поставил СВОЙ blob (после расшифровки), нажал play. */
function playerStarts(stack, networkUrl) {
  const el = stack.doc.createElement('audio');
  el.src = networkUrl || 'blob:https://music.yandex.ru/player-blob';
  el.paused = false;
  el.currentTime = 0;
  el.volume = 0.7;
  el.play();
  return el;
}

async function main() {
  log('\n[4] стек собирается без window.YMU');
  const stack = bootStack({ files: [FILE] });
  check('inject.js инициализировался', typeof stack.win.__ymuState === 'function');
  check('в DOM медиа нет', stack.doc.querySelector('audio') === null);

  log('\n[5] плеер играет свой blob — мы его НЕ трогаем');
  const player = playerStarts(stack);
  const playerSrcBefore = player.src;

  tick(stack);
  await wait(80);
  tick(stack);
  await wait(500);
  tick(stack);

  let st = stack.win.__ymuState();
  check('плеер найден реестром', st.player !== null);
  check('src плеера не изменён (ключевой регресс 0.5.0)',
    player.src === playerSrcBefore, `${player.src} !== ${playerSrcBefore}`);
  check('плеер заглушён', player.muted === true, 'muted=' + player.muted);

  log('\n[6] параллельная копия играет локальный файл');
  check('создан собственный элемент', st.shadow !== null);
  check('источник копии — blob:', String(st.shadow && st.shadow.src).startsWith('blob:'),
    String(st.shadow && st.shadow.src));
  check('копия не на паузе', st.shadow && st.shadow.paused === false, 'paused=' + (st.shadow && st.shadow.paused));
  check('громкость унаследована от плеера',
    st.shadow && Math.abs(st.shadow.volume - 0.7) < 0.01, 'vol=' + (st.shadow && st.shadow.volume));
  check('статус: локальная версия', /локальн/i.test(st.status.text), st.status.text);

  log('\n[7] пауза плеера → копия встаёт на паузу');
  player.paused = true;
  tick(stack);
  await wait(60);
  st = stack.win.__ymuState();
  check('копия на паузе', st.shadow && st.shadow.paused === true, 'paused=' + (st.shadow && st.shadow.paused));

  log('\n[8] смена трека: копия переключается, плеер разглушается при отсутствии файла');
  stack.win.__ymuForcePoll();
  globalThis.navigator.mediaSession.metadata = { title: 'Незнакомый трек', artist: 'Кто-то' };
  tick(stack);
  await wait(400);
  tick(stack);
  st = stack.win.__ymuState();
  check('ключ сменился', st.currentKey === 'кто то|незнакомый трек', String(st.currentKey));
  check('плеер разглушён (файла нет — играет оригинал)',
    player.muted === false, 'muted=' + player.muted);

  log('\n[9] выключенное расширение ничего не глушит');
  const offStack = bootStack({ settings: { enabled: false }, files: [FILE] });
  const offPlayer = playerStarts(offStack);
  tick(offStack);
  await wait(400);
  tick(offStack);
  const st9 = offStack.win.__ymuState();
  check('плеер не заглушён', offPlayer.muted === false, 'muted=' + offPlayer.muted);
  check('копия не создана', st9.shadow === null);

  log('\n[10] битый файл: копия не декодируется → откат и отключение привязки');
  const badStack = bootStack({ files: [FILE], decodeError: true });
  const badPlayer = playerStarts(badStack);
  tick(badStack);
  await wait(500);
  tick(badStack);
  await wait(200);
  const st10 = badStack.win.__ymuState();
  check('плеер разглушён после ошибки', badPlayer.muted === false, 'muted=' + badPlayer.muted);
  check('в статусе ошибка декодирования', /декодир|не удалось|ошибка/i.test(st10.status.text),
    st10.status.text);
  check('привязка отключена в базе', [...badStack.db.__raw.bindings.values()]
    .some((b) => b.disabled === true), JSON.stringify([...badStack.db.__raw.bindings.values()]));

  log('\n[11] неподдерживаемый формат отклоняется до воспроизведения');
  const fmtStack = bootStack({ files: [FILE], canPlay: '' });
  const fmtPlayer = playerStarts(fmtStack);
  tick(fmtStack);
  await wait(400);
  tick(fmtStack);
  const st11 = fmtStack.win.__ymuState();
  check('плеер не заглушён', fmtPlayer.muted === false, 'muted=' + fmtPlayer.muted);
  check('статус говорит про формат', /формат/i.test(st11.status.text), st11.status.text);

  await insertTests();
  finish();
}

/* ============ 4. вставки в волну (0.7.0) ============ */

const INS = {
  id: 'ins-1', name: 'Свой - Вставка.mp3', title: 'Вставка', artists: 'Свой',
  key: 'свой|вставка', durationMs: 120000, size: 20, mime: 'audio/mpeg', insert: true,
  blob: new Blob([Buffer.from('ID3fake-insert-payload')], { type: 'audio/mpeg' }),
};
const WAVE = () => ({ mediaSession: { metadata: { title: 'Обычный трек', artist: 'Кто-то' } } });
const INSERT_ON = { insertEnabled: true, insertChance: 1, insertMinGapMin: 0 };

/** Настоящее состояние элемента: во время вставки плеер видит её геттеры. */
const realOf = (el, name) => (el.__ymuReal ? el.__ymuReal[name].get() : el[name]);

/** Трек доигрывает до конца: жребий, загрузка вставки, «ended». */
async function playToEnd(stack, player) {
  player.duration = 175;
  player.currentTime = 160;            // осталось 15 с — время бросать жребий
  tick(stack);
  await wait(150);
  tick(stack);
  await wait(150);
  tick(stack);
  player.currentTime = 175;
  player.paused = true;
  player.emit('ended');
}

/** Плеер переходит к следующему треку: новый blob в том же элементе и play(). */
function playerNext(player, url) {
  player.src = url;
  player.currentTime = 0;
  return player.play();
}

async function insertTests() {
  log('\n[12] вставка на естественном конце трека');
  const s = bootStack({ files: [FILE, INS], settings: INSERT_ON, navigator: WAVE() });
  const player = playerStarts(s, 'blob:https://music.yandex.ru/track-A');
  await playToEnd(s, player);
  let st = s.win.__ymuState();
  check('вставка подготовлена', st.insert && st.insert.phase === 'armed', JSON.stringify(st.insert));
  check('трек помечен как доигравший', st.insert && st.insert.nearEnd === true);

  const ret = playerNext(player, 'blob:https://music.yandex.ru/track-B');
  await wait(20);
  st = s.win.__ymuState();
  check('play() следующего трека поглощён', ret && typeof ret.then === 'function');
  check('вставка играет', st.insert && st.insert.phase === 'playing', JSON.stringify(st.insert));
  check('следующий трек придержан на паузе', realOf(player, 'paused') === true, 'paused=' + realOf(player, 'paused'));
  check('плеер видит вставку играющей', player.paused === false);
  check('src следующего трека не тронут', player.src === 'blob:https://music.yandex.ru/track-B', player.src);
  check('свой элемент вставки играет', st.insertEl && st.insertEl.paused === false);
  check('источник вставки — blob:', st.insertEl && st.insertEl.src.startsWith('blob:'), st.insertEl && st.insertEl.src);
  check('громкость вставки = громкость плеера', st.insertEl && Math.abs(st.insertEl.volume - 0.7) < 0.01,
    st.insertEl && st.insertEl.volume);
  tick(s);
  check('плашка показывает вставку', /вставка/.test(s.win.__ymuState().status.text), s.win.__ymuState().status.text);
  check('интервал отсчитывается от старта вставки', (await s.db.getSetting('lastInsertAt', 0)) > 0);

  log('\n[13] кнопки плеера управляют вставкой');
  let pauses = 0;
  player.addEventListener('pause', () => pauses++);
  player.pause();
  await wait(10);
  st = s.win.__ymuState();
  check('«пауза» в плеере ставит вставку на паузу', st.insertEl.paused === true && st.insert.paused === true);
  check('кнопка плеера видит паузу вставки', player.paused === true);
  check('интерфейс плеера получил событие pause', pauses > 0);
  player.play();
  await wait(10);
  st = s.win.__ymuState();
  check('«играть» в плеере продолжает вставку', st.insertEl.paused === false && st.insert.paused === false);
  check('следующий трек всё ещё придержан', realOf(player, 'paused') === true);

  player.volume = 0.3;
  tick(s);
  check('громкость плеера применяется ко вставке', Math.abs(s.win.__ymuState().insertEl.volume - 0.3) < 0.01);

  const insEl = s.created.find((el) => el.__ymuOwn && String(el.src).startsWith('blob:') && el !== (s.created.find((e) => e === player)));
  insEl.duration = 120;
  insEl.currentTime = 30;
  check('ползунок плеера показывает позицию вставки', Math.abs(player.currentTime - 30 * 175 / 120) < 0.01,
    'currentTime=' + player.currentTime);
  let seeked = 0;
  player.addEventListener('seeked', () => seeked++);
  player.currentTime = 87.5;           // ползунок плеера на середину
  check('ползунок плеера перематывает вставку', Math.abs(insEl.currentTime - 60) < 0.5, 'currentTime=' + insEl.currentTime);
  check('интерфейс получил seeked', seeked > 0);
  check('настоящая позиция трека не тронута', realOf(player, 'currentTime') === 0, 'currentTime=' + realOf(player, 'currentTime'));
  check('ended для плеера — false', player.ended === false);
  tick(s);
  check('системная плашка ОС показывает вставку', globalThis.navigator.mediaSession.metadata &&
    globalThis.navigator.mediaSession.metadata.title === 'Вставка', JSON.stringify(globalThis.navigator.mediaSession.metadata));
  check('без обложки в файле — заглушка', /^data:image\/svg/.test(globalThis.navigator.mediaSession.metadata.artwork[0].src));
  check('заголовок вкладки — вставка', s.doc.title === 'Вставка — Свой', s.doc.title);

  log('\n[14] вставка доиграла → волна идёт дальше');
  insEl.emit('ended');
  st = s.win.__ymuState();
  check('вставка завершена', st.insert === null, JSON.stringify(st.insert));
  check('придержанный трек запущен', player.paused === false, 'paused=' + player.paused);
  check('геттеры сняты с элемента', !player.__ymuReal && Object.getOwnPropertyDescriptor(player, 'currentTime').writable === true);
  check('трек начинается с 0:00', player.currentTime === 0, 'currentTime=' + player.currentTime);
  check('метаданные ОС вернулись к треку', globalThis.navigator.mediaSession.metadata.title === 'Обычный трек',
    JSON.stringify(globalThis.navigator.mediaSession.metadata));
  check('заголовок вкладки вернулся', s.doc.title === 'Яндекс.Музыка', s.doc.title);

  log('\n[15] интервал: раньше времени вставки нет');
  await s.db.setSetting('insertMinGapMin', 30);
  await playToEnd(s, player);
  st = s.win.__ymuState();
  check('жребий не брошен до истечения интервала', st.insert === null, JSON.stringify(st.insert));
  playerNext(player, 'blob:https://music.yandex.ru/track-C');
  check('следующий трек играет сразу', player.paused === false);

  log('\n[16] галочка «при ручном переключении» выключена — ручное переключение вставку сжигает');
  const m = bootStack({ files: [INS], settings: Object.assign({}, INSERT_ON, { insertOnSkip: false }), navigator: WAVE() });
  const mp = playerStarts(m, 'blob:https://music.yandex.ru/track-A');
  mp.duration = 175;
  mp.currentTime = 160;
  tick(m);
  await wait(150);
  tick(m);
  await wait(150);
  tick(m);                            // вставка подготовлена, но трек не доигран
  check('вставка была подготовлена', m.win.__ymuState().insert && m.win.__ymuState().insert.phase === 'armed',
    JSON.stringify(m.win.__ymuState().insert));
  mp.currentTime = 165;
  playerNext(mp, 'blob:https://music.yandex.ru/track-B');   // нажали «следующий»
  check('вставка отменена', m.win.__ymuState().insert === null, JSON.stringify(m.win.__ymuState().insert));
  check('выбранный трек играет', mp.paused === false);

  log('\n[16б] ручное переключение: жребий в начале трека, вставка при нажатии «следующий»');
  const k = bootStack({ files: [INS], settings: INSERT_ON, navigator: WAVE() });
  const ka = playerStarts(k, 'blob:https://music.yandex.ru/track-A');
  ka.duration = 175;
  ka.currentTime = 20;                 // трек только начался
  await wait(100);
  tick(k); await wait(150); tick(k); await wait(150); tick(k);
  check('вставка готова уже в начале трека', k.win.__ymuState().insert && k.win.__ymuState().insert.phase === 'armed',
    JSON.stringify(k.win.__ymuState().insert) + ' ' + k.win.__ymuState().insertNote);
  ka.currentTime = 40;
  ka.pause();                          // плеер сам останавливает старый трек при переключении
  playerNext(ka, 'blob:https://music.yandex.ru/track-B');   // нажали «следующий»
  st = k.win.__ymuState();
  check('вставка играет перед выбранным треком', st.insert && st.insert.phase === 'playing', JSON.stringify(st.insert));
  check('выбранный трек придержан', realOf(ka, 'paused') === true);
  k.created.find((e) => e.__ymuOwn && String(e.src).startsWith('blob:') && e !== ka).emit('ended');
  check('после вставки играет выбранный трек', ka.paused === false && ka.src.endsWith('track-B'));

  log('\n[16в] интервал истёк посреди трека — жребий бросается ещё раз');
  const g = bootStack({ files: [INS], settings: Object.assign({}, INSERT_ON, { insertMinGapMin: 1 }), navigator: WAVE() });
  await g.db.setSetting('lastInsertAt', Date.now() - 60000 + 300);   // интервал истекает через 0.3 с
  const ga = playerStarts(g, 'blob:https://music.yandex.ru/track-A');
  ga.duration = 175; ga.currentTime = 20;
  await wait(100);
  tick(g); await wait(150); tick(g);
  check('сначала — интервал', /интервал/.test(g.win.__ymuState().insertNote), g.win.__ymuState().insertNote);
  await wait(900);
  tick(g); await wait(150); tick(g); await wait(150); tick(g);
  check('потом вставка готова в том же треке', g.win.__ymuState().insert && g.win.__ymuState().insert.phase === 'armed',
    JSON.stringify(g.win.__ymuState().insert) + ' ' + g.win.__ymuState().insertNote);

  log('\n[17] «следующий» во время вставки отменяет её');
  const n = bootStack({ files: [INS], settings: INSERT_ON, navigator: WAVE() });
  const np = playerStarts(n, 'blob:https://music.yandex.ru/track-A');
  await playToEnd(n, np);
  playerNext(np, 'blob:https://music.yandex.ru/track-B');
  check('вставка началась', n.win.__ymuState().insert && n.win.__ymuState().insert.phase === 'playing');
  playerNext(np, 'blob:https://music.yandex.ru/track-C');   // «следующий» в плеере
  st = n.win.__ymuState();
  check('вставка отменена', st.insert === null, JSON.stringify(st.insert));
  check('вставка замолчала', st.insertEl.paused === true);
  check('выбранный трек играет', np.paused === false && np.src.endsWith('track-C'));

  log('\n[19] плавный переход: следующий трек стартует за 8 с до конца');
  const x = bootStack({ files: [INS], settings: INSERT_ON, navigator: WAVE() });
  const xa = playerStarts(x, 'blob:https://music.yandex.ru/track-A');
  xa.duration = 175;
  xa.currentTime = 160;
  tick(x); await wait(150); tick(x); await wait(150); tick(x);
  xa.currentTime = 167;                // осталось 8 с, трек ещё играет
  tick(x);
  const xb = x.doc.createElement('audio');   // плеер берёт второй элемент для следующего трека
  xb.src = 'blob:https://music.yandex.ru/track-B';
  xb.play();
  await wait(10);
  st = x.win.__ymuState();
  check('переход засчитан как естественный', st.insert && st.insert.phase === 'playing', JSON.stringify(st.insert) + ' ' + st.insertNote);
  check('хвост предыдущего трека заглушён', xa.paused === true);
  check('следующий трек придержан', realOf(xb, 'paused') === true);

  log('\n[20] длительность неизвестна — берём её из mediaSession.setPositionState');
  let lastPS = null;
  const msNav = { mediaSession: { metadata: { title: 'Обычный трек', artist: 'Кто-то' }, setPositionState: (v) => { lastPS = v; } } };
  const y = bootStack({ files: [INS], settings: INSERT_ON, navigator: msNav });
  const ya = playerStarts(y, 'blob:https://music.yandex.ru/track-A');
  ya.duration = Infinity;              // поток без длительности
  ya.currentTime = 160;
  globalThis.navigator.mediaSession.setPositionState({ duration: 175, position: 160, playbackRate: 1 });
  check('setPositionState плеера по-прежнему вызывается', lastPS && lastPS.duration === 175);
  tick(y); await wait(150); tick(y); await wait(150); tick(y);
  check('вставка подготовлена без audio.duration', y.win.__ymuState().insert && y.win.__ymuState().insert.phase === 'armed',
    JSON.stringify(y.win.__ymuState().insert) + ' ' + y.win.__ymuState().insertNote);

  log('\n[21] запасной путь: следующий трек заиграл без play()');
  const z = bootStack({ files: [INS], settings: INSERT_ON, navigator: WAVE() });
  const za = playerStarts(z, 'blob:https://music.yandex.ru/track-A');
  await playToEnd(z, za);
  za.src = 'blob:https://music.yandex.ru/track-B';
  za.currentTime = 0;
  za.paused = false;                   // плеер запустил трек в обход play()
  tick(z);
  await wait(10);
  st = z.win.__ymuState();
  check('вставка всё равно началась', st.insert && st.insert.phase === 'playing', JSON.stringify(st.insert) + ' ' + st.insertNote);
  check('следующий трек остановлен', realOf(za, 'paused') === true);

  log('\n[22] причина отказа видна на плашке');
  const q = bootStack({ files: [FILE], settings: Object.assign({}, INSERT_ON, { insertOnSkip: false }), navigator: WAVE() });
  const qa = playerStarts(q, 'blob:https://music.yandex.ru/track-A');
  qa.duration = 175;
  qa.currentTime = 100;
  await wait(100);                     // настройки приходят странице асинхронно
  tick(q);
  check('пока рано — пишет, когда будет жребий', /жребий за 25 с/.test(q.win.__ymuState().insertNote), q.win.__ymuState().insertNote);
  qa.currentTime = 160;
  tick(q); await wait(150); tick(q);
  check('нет файлов — так и пишет', /галочкой «Вставка»/.test(q.win.__ymuState().insertNote), q.win.__ymuState().insertNote);
  check('причина попала в диагностику', ((await q.db.getSetting('diag', [])) || []).some((d) => /галочкой/.test(d.stage)));

  log('\n[23] «вставить после трека» из попапа: без жребия и интервала');
  const f = bootStack({ files: [INS], settings: { insertEnabled: true, insertChance: 0, insertMinGapMin: 60, lastInsertAt: Date.now() }, navigator: WAVE() });
  const fa = playerStarts(f, 'blob:https://music.yandex.ru/track-A');
  fa.duration = 175;
  fa.currentTime = 30;                 // до конца ещё далеко
  tick(f);
  f.win.dispatchEvent({ type: 'ymu:to-page', detail: JSON.stringify({ kind: 'insertNext' }) });
  await wait(150); tick(f); await wait(150); tick(f);
  check('вставка подготовлена сразу', f.win.__ymuState().insert && f.win.__ymuState().insert.phase === 'armed',
    JSON.stringify(f.win.__ymuState().insert) + ' ' + f.win.__ymuState().insertNote);
  await playToEnd(f, fa);
  playerNext(fa, 'blob:https://music.yandex.ru/track-B');
  check('и сыграла после трека', f.win.__ymuState().insert && f.win.__ymuState().insert.phase === 'playing');

  log('\n[24] бар плеера: название, исполнитель и обложка вставки');
  const COVER = 'data:image/jpeg;base64,/9j/AAAA';
  const u = bootStack({ files: [Object.assign({}, INS, { cover: COVER })], settings: INSERT_ON, navigator: WAVE() });
  const text = (v) => ({ nodeType: 3, nodeValue: v });
  const node = (props) => Object.assign({ isConnected: true, style: { display: '' }, children: [], texts: [],
    getAttribute(n) { return this.attrs && this.attrs[n] || null; },
    querySelectorAll(sel) {
      if (sel === 'button') return this.buttons || [];
      if (sel.includes('/artist/')) return this.artistLinks || [];
      return [];
    },
    querySelector(sel) { return sel === 'img' ? (this.img || null) : null; },
  }, props);
  const tTitle = text('Трек Яндекса'), tA1 = text('Артист Яндекса'), tA2 = text('Второй артист');
  const titleLink = node({ texts: [tTitle], title: 'Трек Яндекса' });
  const a1 = node({ texts: [tA1] }), a2 = node({ texts: [tA2] });
  const img = node({ src: 'https://avatars.yandex.net/cover.jpg', srcset: 'x 2x' });
  const row = node({ img });
  const bar = node({ artistLinks: [a1, a2], buttons: [
    node({ attrs: { 'aria-label': 'Пауза' } }), node({ attrs: { 'aria-label': 'Следующий трек' } })] });
  titleLink.parentElement = row; row.parentElement = bar; bar.parentElement = null;
  u.doc.querySelectorAll = (sel) => (sel.includes('/track/') ? [titleLink] : []);
  u.doc.createTreeWalker = (el) => { let i = 0; const arr = el.texts || []; return { nextNode: () => arr[i++] || null }; };
  const ua = playerStarts(u, 'blob:https://music.yandex.ru/track-A');
  await playToEnd(u, ua);
  playerNext(ua, 'blob:https://music.yandex.ru/track-B');
  tick(u);
  check('название в баре — вставка', tTitle.nodeValue === 'Вставка', tTitle.nodeValue);
  check('исполнитель в баре — вставка', tA1.nodeValue === 'Свой', tA1.nodeValue);
  check('лишние исполнители скрыты', a2.style.display === 'none');
  check('обложка — из файла', img.src === COVER && img.srcset === '', img.src);
  check('в ОС — обложка из файла', globalThis.navigator.mediaSession.metadata.artwork[0].src === COVER);
  u.created.find((el) => el.__ymuOwn && String(el.src).startsWith('blob:') && el !== ua).emit('ended');
  check('название вернулось', tTitle.nodeValue === 'Трек Яндекса', tTitle.nodeValue);
  check('исполнители вернулись', tA1.nodeValue === 'Артист Яндекса' && a2.style.display === '');
  check('обложка вернулась', img.src === 'https://avatars.yandex.net/cover.jpg' && img.srcset === 'x 2x');

  log('\n[25] бар ищется по тексту текущего трека внизу экрана, время — на ползунке');
  const v = bootStack({ files: [INS], settings: INSERT_ON, navigator: WAVE() });
  globalThis.innerHeight = 800;
  const el = (top, extra) => Object.assign({ isConnected: true, style: { display: '' }, tagName: 'DIV',
    getBoundingClientRect: () => ({ top, height: 20, width: 100, left: 0 }),
    getAttribute: () => null, querySelectorAll: () => [], querySelector: () => null, texts: [] }, extra);
  const t = (value, parent) => ({ nodeType: 3, nodeValue: value, parentElement: parent });
  const vImg = { src: 'https://avatars.yandex.net/b.jpg', srcset: '' };
  const vRoot = el(690, { querySelectorAll: (sel) => (sel === 'img' ? [vImg] : sel === 'button' ? [1, 2, 3] : []),
    querySelector: (sel) => (sel === 'img' ? vImg : null) });
  const vTitleEl = el(700, { parentElement: vRoot }), vArtEl = el(720, { parentElement: vRoot });
  const vBar = el(680, { className: 'PlayerBarDesktopWithBackgroundProgressBar_root' });
  vRoot.parentElement = vBar;
  const vProg = el(740, { parentElement: vBar });
  const vCurEl = el(740, { parentElement: vProg }), vDurEl = el(740, { parentElement: vProg });
  const decoyEl = el(200, { parentElement: null });        // то же название в списке выше
  const vt = { title: t('Обычный трек', vTitleEl), art: t('Кто-то', vArtEl), cur: t('00:00', vCurEl),
    dur: t('02:55', vDurEl), decoy: t('Обычный трек', decoyEl) };
  vRoot.texts = [vt.title, vt.art];                 // в блоке названия времени нет
  vProg.texts = [vt.dur, vt.cur];                   // у Яндекса длина идёт в разметке первой
  vBar.texts = [vt.title, vt.art, vt.dur, vt.cur];
  const vBody = el(0, { texts: [vt.decoy, ...vBar.texts], appendChild() {} });
  v.doc.body = vBody;
  v.doc.createTreeWalker = (root) => { let i = 0; const arr = root.texts || []; return { nextNode: () => arr[i++] || null }; };
  const va = playerStarts(v, 'blob:https://music.yandex.ru/track-A');
  await playToEnd(v, va);
  playerNext(va, 'blob:https://music.yandex.ru/track-B');
  const vIns = v.created.find((e) => e.__ymuOwn && String(e.src).startsWith('blob:') && e !== va);
  vIns.duration = 120; vIns.currentTime = 65;
  tick(v);
  check('название в баре заменено', vt.title.nodeValue === 'Вставка', vt.title.nodeValue);
  check('то же название в списке не тронуто', vt.decoy.nodeValue === 'Обычный трек');
  check('исполнитель заменён', vt.art.nodeValue === 'Свой', vt.art.nodeValue);
  check('обложка — заглушка', /^data:image\/svg/.test(vImg.src));
  check('время из полосы прогресса — вставки, в формате плеера', vt.cur.nodeValue === '01:05' && vt.dur.nodeValue === '02:00',
    vt.cur.nodeValue + ' / ' + vt.dur.nodeValue);
  vt.cur.nodeValue = '00:47';           // React вернул своё значение
  vIns.currentTime = 66;
  tick(v);
  check('время возвращается к вставке после перерисовки', vt.cur.nodeValue === '01:06', vt.cur.nodeValue);
  check('длина не перепутана с позицией', vt.dur.nodeValue === '02:00', vt.dur.nodeValue);
  vIns.emit('ended');
  check('после вставки бар как был', vt.title.nodeValue === 'Обычный трек' && vt.art.nodeValue === 'Кто-то' &&
    vt.dur.nodeValue === '02:55' && vImg.src === 'https://avatars.yandex.net/b.jpg');

  log('\n[26] треки без файла: только через Media Session, импорт убирает трек');
  const w = bootStack({ files: [] });
  await w.sw.call('track', { title: 'Незнакомый трек', artists: 'Кто-то', via: 'mediaSession' });
  await w.sw.call('track', { title: 'Незнакомый трек', artists: 'Кто-то', via: 'mediaSession' });
  await w.sw.call('track', { title: 'слушать онлайн бесплатно на Яндекс Музыке', artists: 'Плейлист', via: 'DOM:title' });
  let miss = (await w.sw.call('getMissing')).missing;
  check('трек без файла записан', miss.length === 1 && miss[0].title === 'Незнакомый трек', JSON.stringify(miss));
  check('счётчик прослушиваний', miss[0] && miss[0].count === 2);
  check('заголовок вкладки не попал в список', !miss.some((m) => /слушать онлайн/.test(m.title)));
  await w.sw.call('hideMissing', { key: miss[0].key });
  miss = (await w.sw.call('getMissing')).missing;
  check('скрытие запоминается', miss[0].hidden === true);
  await w.db.putFile({ id: 'f-new', key: miss[0].key, title: 'Незнакомый трек', artists: 'Кто-то', blob: new Blob(['x']) });
  miss = (await w.sw.call('getMissing')).missing;
  check('после импорта файла трек ушёл из списка', miss.length === 0, JSON.stringify(miss));

  log('\n[27] автоимпорт: загрузка завершилась → файл в библиотеке → играющий трек включён');
  const dl = { listeners: [], items: {} };
  const downloads = {
    onChanged: { addListener: (fn) => dl.listeners.push(fn) },
    search: async (q) => [dl.items[q.id]].filter(Boolean),
  };
  const adb = makeDb();
  const env = { downloads };
  const asw = bootServiceWorker(adb, env);
  const tabletka = new File([Buffer.from('ID3fake-mp3')], 'МУККА - Таблетка.mp3', { type: 'audio/mpeg' });
  const folder = {
    kind: 'directory', name: 'Downloads',
    async *entries() { yield ['МУККА - Таблетка.mp3', { kind: 'file', getFile: async () => tabletka }]; },
    queryPermission: async () => 'granted',
  };
  await adb.setSetting('importDir', folder);
  await asw.call('track', { title: 'Таблетка', artists: 'МУККА', via: 'mediaSession' });   // трек играет, файла нет
  check('сначала файла нет — трек в «без файла»', (await asw.call('getMissing')).missing.length === 1);
  // Chrome сообщает о завершённой загрузке
  dl.items[7] = { id: 7, filename: 'C:\\Users\\me\\Downloads\\МУККА - Таблетка.mp3', mime: 'audio/mpeg', fileSize: tabletka.size };
  dl.items[8] = { id: 8, filename: 'C:\\Users\\me\\Downloads\\setup.exe', mime: 'application/octet-stream', fileSize: 5 };
  dl.listeners.forEach((fn) => fn({ id: 8, state: { current: 'complete' } }));
  dl.listeners.forEach((fn) => fn({ id: 7, state: { current: 'complete' } }));
  await wait(300);
  const libNow = await adb.allFiles();
  check('скачанный трек в библиотеке', libNow.length === 1 && libNow[0].name === 'МУККА - Таблетка.mp3', JSON.stringify(libNow.map((f) => f.name)));
  check('не-аудио проигнорировано', !libNow.some((f) => /setup/.test(f.name)));
  check('файл привязан к играющему треку', [...adb.__raw.bindings.values()].some((b) => b.key === 'мукка|таблетка' && b.fileId === libNow[0].id));
  check('трек ушёл из «без файла»', (await asw.call('getMissing')).missing.length === 0);
  check('очередь пуста, бейдж снят', ((await adb.getSetting('importQueue', [])) || []).length === 0 && !env.chrome.__badge);
  const lockedDb = makeDb();
  const lenv = { downloads };
  bootServiceWorker(lockedDb, lenv);
  await lockedDb.setSetting('importDir', Object.assign({}, folder, { queryPermission: async () => 'prompt' }));
  dl.listeners.slice(-1)[0]({ id: 7, state: { current: 'complete' } });
  await wait(300);
  check('нет доступа к папке — в очереди и «+1» на иконке', ((await lockedDb.getSetting('importQueue', [])) || []).length === 1 && lenv.chrome.__badge === '+1',
    String(lenv.chrome.__badge));

  log('\n[28] имя файла без « - » («Мукка Таблетка.mp3»): автоматч при обычном пороге');
  const plain = (id, name) => ({ id, name, title: name.replace(/\.mp3$/, ''), artists: '', key: '|' + name.replace(/\.mp3$/, '').toLowerCase(),
    durationMs: 0, size: 5, mime: 'audio/mpeg', blob: new Blob([Buffer.from('nothing')], { type: 'audio/mpeg' }) });
  const mdb = makeDb();
  for (const f of [plain('m1', 'Мукка Таблетка.mp3'), plain('m2', 'Мукка Девочка С Каре.mp3'), plain('m3', 'Пошлая Молли Ханнамонтана.mp3')]) mdb.__raw.files.set(f.id, f);
  const msw = bootServiceWorker(mdb);
  let mr = await msw.call('track', { title: 'Таблетка', artists: 'МУККА', via: 'mediaSession' });
  check('«МУККА — Таблетка» → «Мукка Таблетка.mp3»', mr && mr.fileId === 'm1', JSON.stringify(mr));
  mr = await msw.call('track', { title: 'Девочка с каре', artists: 'МУККА', via: 'mediaSession' });
  check('«МУККА — Девочка с каре» → свой файл, не «Таблетка»', mr && mr.fileId === 'm2', JSON.stringify(mr));
  mr = await msw.call('track', { title: 'Город горит', artists: 'Кто-то', via: 'mediaSession' });
  check('чужой трек ни к чему не привязан', mr && !mr.fileId, JSON.stringify(mr));

  log('\n[29] старые файлы: теги перечитываются один раз, ключ обновляется');
  const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const ssafe = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
  const fr = (id, str) => { const body = Buffer.concat([Buffer.from([3]), Buffer.from(str, 'utf8')]);
    return Buffer.concat([Buffer.from(id), be32(body.length), Buffer.from([0, 0]), body]); };
  const frames = Buffer.concat([fr('TPE1', 'Пошлая Молли'), fr('TIT2', 'Дом Периньон')]);
  const tagged = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), ssafe(frames.length), frames, Buffer.from('audio')]);
  const tdb = makeDb();
  tdb.__raw.files.set('t1', { id: 't1', name: 'track_0042.mp3', title: 'track 0042', artists: '', key: '|track 0042',
    size: tagged.length, mime: 'audio/mpeg', blob: new Blob([tagged], { type: 'audio/mpeg' }) });
  const tsw = bootServiceWorker(tdb);
  const tr = await tsw.call('track', { title: 'Дом Периньон', artists: 'Пошлая Молли', via: 'mediaSession' });
  check('файл с бессмысленным именем найден по тегам', tr && tr.fileId === 't1', JSON.stringify(tr));
  const tf = tdb.__raw.files.get('t1');
  check('в библиотеке теперь исполнитель и название из тегов', tf.artists === 'Пошлая Молли' && tf.title === 'Дом Периньон' && tf.metaChecked === 2,
    JSON.stringify({ a: tf.artists, t: tf.title, k: tf.key }));

  log('\n[18] вставки выключены — ничего не происходит');
  const o = bootStack({ files: [INS], navigator: WAVE() });
  const op = playerStarts(o, 'blob:https://music.yandex.ru/track-A');
  await playToEnd(o, op);
  check('вставка не готовилась', o.win.__ymuState().insert === null);
  playerNext(op, 'blob:https://music.yandex.ru/track-B');
  check('следующий трек играет сразу', op.paused === false);
}

main().catch((e) => {
  REAL_CONSOLE.log('НЕОБРАБОТАННАЯ ОШИБКА:', e.message);
  REAL_CONSOLE.log(e.stack);
  process.exit(1);
});

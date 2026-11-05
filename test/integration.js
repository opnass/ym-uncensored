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

function bootServiceWorker(db) {
  const listeners = [];
  const importScripts = (...paths) => {
    for (const p of paths) {
      if (p.includes('normalize.js')) {
        new Function('self', 'module', read('normalize.js') + '\n').call(globalThis, globalThis, {});
      } else if (p.includes('db.js')) {
        globalThis.YMUDB = db;
      }
    }
  };
  const chromeStub = {
    runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, lastError: null },
    tabs: { query: (q, cb) => cb([]), sendMessage: () => Promise.resolve() },
  };
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

  finish();
}

main().catch((e) => {
  REAL_CONSOLE.log('НЕОБРАБОТАННАЯ ОШИБКА:', e.message);
  REAL_CONSOLE.log(e.stack);
  process.exit(1);
});

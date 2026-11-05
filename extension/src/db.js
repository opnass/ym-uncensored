/* db.js — IndexedDB в контексте расширения. Файлы и привязки.
   Привязки хранятся по нормализованному ключу "артисты|название" — это устойчивее, чем trackId. */
(function (root) {
  'use strict';

  const DB_NAME = 'ym_uncensored';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) {
          const s = db.createObjectStore('files', { keyPath: 'id' });
          s.createIndex('key', 'key', { unique: false });
        }
        if (!db.objectStoreNames.contains('bindings')) {
          const s = db.createObjectStore('bindings', { keyPath: 'key' });
          s.createIndex('fileId', 'fileId', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('capture')) {
          const s = db.createObjectStore('capture', { keyPath: 'id', autoIncrement: true });
          s.createIndex('ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function store(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  const wrap = (r) => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

  const api = {
    async putFile(rec) { return wrap((await store('files', 'readwrite')).put(rec)); },
    async getFile(id) { return wrap((await store('files', 'readonly')).get(id)); },
    async allFiles() { return wrap((await store('files', 'readonly')).getAll()); },
    async deleteFile(id) { return wrap((await store('files', 'readwrite')).delete(id)); },

    async putBinding(b) { return wrap((await store('bindings', 'readwrite')).put(b)); },
    async getBinding(key) { return wrap((await store('bindings', 'readonly')).get(String(key))); },
    async allBindings() { return wrap((await store('bindings', 'readonly')).getAll()); },
    async deleteBinding(key) { return wrap((await store('bindings', 'readwrite')).delete(String(key))); },
    async bindingsForFile(fileId) {
      const all = await api.allBindings();
      return all.filter((b) => b.fileId === fileId);
    },

    async getSetting(key, fallback) {
      const row = await wrap((await store('settings', 'readonly')).get(key));
      return row ? row.value : fallback;
    },
    async setSetting(key, value) {
      return wrap((await store('settings', 'readwrite')).put({ key, value }));
    },
    async allSettings() {
      const rows = await wrap((await store('settings', 'readonly')).getAll());
      const out = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    },

    async pushCapture(rec) { return wrap((await store('capture', 'readwrite')).add(rec)); },
    async allCapture() { return wrap((await store('capture', 'readonly')).getAll()); },
    async clearCapture() { return wrap((await store('capture', 'readwrite')).clear()); },
  };

  root.YMUDB = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

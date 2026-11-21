'use strict';
// Cache settings trong RAM, xoá cache khi ghi
const db = require('../db');

let cache = null;
const qAll = db.prepare('SELECT key, value FROM settings');
const qSet = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function all() {
  if (!cache) cache = Object.fromEntries(qAll.all().map(r => [r.key, r.value]));
  return cache;
}
function get(key) { return all()[key]; }
function set(obj) {
  db.transaction(() => { for (const [k, v] of Object.entries(obj)) qSet.run(k, v == null ? '' : String(v)); })();
  cache = null;
}

module.exports = { all, get, set };

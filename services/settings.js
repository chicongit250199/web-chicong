'use strict';
// Cache settings trong RAM (nạp 1 lần), ghi thì cập nhật cache luôn
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
  // Cập nhật cache tại chỗ (không xóa): hàm SQL như task_alert_days đọc settings giữa lúc đang chạy query,
  // nếu cache rỗng sẽ phải query lồng -> lỗi "connection is busy"
  if (cache) for (const [k, v] of Object.entries(obj)) cache[k] = v == null ? '' : String(v);
}

module.exports = { all, get, set };

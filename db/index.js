'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -16000'); // ~16MB cache trang
db.pragma('mmap_size = 134217728'); // đọc file DB qua mmap (128MB) — nhanh hơn khi nhiều người xem cùng lúc
db.pragma('temp_store = MEMORY');

// Cache câu lệnh đã biên dịch: nhiều route gọi db.prepare(sql) trong mỗi request -> SQLite phải phân tích lại SQL.
// Cùng chuỗi SQL dùng lại statement cũ (better-sqlite3 tự biên dịch lại khi schema đổi). Không có chỗ nào gọi
// .pluck()/.raw()/.expand() (làm đổi trạng thái statement), nên dùng chung an toàn.
const rawPrepare = db.prepare.bind(db);
const stmtCache = new Map();
db.prepare = sql => {
  let st = stmtCache.get(sql);
  if (!st) {
    st = rawPrepare(sql);
    if (stmtCache.size >= 1000) stmtCache.clear(); // SQL ghép động (LIMIT, IN (...)) không làm phình RAM
    stmtCache.set(sql, st);
  }
  return st;
};

// vn(text): bỏ dấu + chữ thường, để tìm kiếm tiếng Việt không phân biệt dấu/hoa thường ("ha duy" khớp "HÀ DUY")
const vn = s => (s == null ? null : String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase());
db.function('vn', { deterministic: true }, vn);
db.vn = vn;
// inv_cat(name): danh mục hàng trong kho đoán theo tên (Main, CPU, RAM...) — services/invCategory.js
db.function('inv_cat', { deterministic: true }, n => require('../services/invCategory').categorize(n));

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(f, new Date().toISOString());
    })();
    console.log(`[db] migrated ${f}`);
  }
}

migrate();
require('./seed')(db);

module.exports = db;

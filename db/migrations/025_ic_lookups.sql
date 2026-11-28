-- Tra cứu IC (AI): lưu kết quả theo mã để xem lại / không gọi AI lại. key = mã IC chỉ giữ chữ số, chữ thường
CREATE TABLE ic_lookups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  result TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_ic_lookups_created ON ic_lookups(created_at);

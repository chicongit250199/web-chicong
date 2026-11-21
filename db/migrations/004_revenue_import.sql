-- 004: đánh dấu doanh thu nhập từ Excel (để lọc / xóa cả đợt, chống nhập trùng)
ALTER TABLE revenues ADD COLUMN source TEXT;          -- NULL = phát sinh trên web, 'excel' = nhập từ file
ALTER TABLE revenues ADD COLUMN import_batch TEXT;    -- mã đợt nhập
CREATE INDEX idx_revenues_batch ON revenues(import_batch);

CREATE TABLE import_batches (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,          -- 'revenue'
  file_name   TEXT,
  row_count   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  date_from   TEXT,
  date_to     TEXT,
  user_name   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

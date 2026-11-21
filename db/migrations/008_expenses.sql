-- 008: Chi phí (tiền chi ra: nhập hàng, mua máy, chi phí cửa hàng...)
CREATE TABLE expenses (
  id             INTEGER PRIMARY KEY,
  expense_date   TEXT NOT NULL,              -- YYYY-MM-DD (giờ VN)
  content        TEXT NOT NULL,
  amount         INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','transfer')),
  note           TEXT,
  staff_name     TEXT,
  source         TEXT,                       -- NULL = nhập trên web, 'excel' = từ file
  import_batch   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_expenses_date ON expenses(expense_date);
CREATE INDEX idx_expenses_batch ON expenses(import_batch);
ALTER TABLE import_batches ADD COLUMN expense_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_batches ADD COLUMN expense_total INTEGER NOT NULL DEFAULT 0;

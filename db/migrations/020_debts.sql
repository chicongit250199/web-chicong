-- 020: CÔNG NỢ
-- Bán / trả máy cho nợ (toàn bộ hoặc trả trước 1 phần): các dòng doanh thu của đơn ghi payment_method = 'debt'
-- (doanh thu tính lúc bán), debtor_key gộp nợ theo người nợ: 'p:<id đối tác>' | 'c:<SĐT>' | 'n:<tên không dấu>'.
-- Tiền khách trả (trả trước lúc mua + thu nợ về sau) ghi ở debt_payments — KHÔNG cộng vào doanh thu lần nữa.
-- Còn nợ = SUM(revenues.amount WHERE debt) − SUM(debt_payments.amount) theo debtor_key.

-- Dựng lại bảng revenues để nới CHECK payment_method (SQLite không sửa được CHECK). Không bảng nào tham chiếu revenues.
CREATE TABLE revenues_new (
  id               INTEGER PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('repair','sale')),
  ref_id           INTEGER,
  customer_name    TEXT,
  customer_phone   TEXT,
  delivery_address TEXT,
  content          TEXT,
  amount           INTEGER NOT NULL DEFAULT 0,
  payment_method   TEXT NOT NULL CHECK (payment_method IN ('cash','transfer','debt')),
  warranty_months  INTEGER,
  staff_name       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source           TEXT,
  import_batch     TEXT,
  order_code       TEXT,
  debtor_key       TEXT
);
INSERT INTO revenues_new (id, type, ref_id, customer_name, customer_phone, delivery_address, content, amount, payment_method,
                          warranty_months, staff_name, created_at, source, import_batch, order_code)
  SELECT id, type, ref_id, customer_name, customer_phone, delivery_address, content, amount, payment_method,
         warranty_months, staff_name, created_at, source, import_batch, order_code FROM revenues;
DROP TABLE revenues;
ALTER TABLE revenues_new RENAME TO revenues;
CREATE INDEX idx_revenues_created ON revenues(created_at);
CREATE INDEX idx_revenues_type ON revenues(type, payment_method);
CREATE INDEX idx_revenues_batch ON revenues(import_batch);
CREATE INDEX idx_revenues_vn_day ON revenues(date(created_at, '+7 hours'));
CREATE INDEX idx_revenues_vn_month ON revenues(strftime('%Y-%m', created_at, '+7 hours'));
CREATE INDEX idx_revenues_order ON revenues(order_code);
CREATE INDEX idx_revenues_debtor ON revenues(debtor_key) WHERE debtor_key IS NOT NULL;

CREATE TABLE debt_payments (
  id             INTEGER PRIMARY KEY,
  debtor_key     TEXT NOT NULL,
  amount         INTEGER NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','transfer')),
  order_code     TEXT,            -- trả trước lúc mua: số phiếu của đơn đó (xóa đơn thì xóa theo)
  note           TEXT,
  staff_name     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_debt_payments_debtor ON debt_payments(debtor_key, created_at);
CREATE INDEX idx_debt_payments_vn_day ON debt_payments(date(created_at, '+7 hours'));
CREATE INDEX idx_debt_payments_order ON debt_payments(order_code);

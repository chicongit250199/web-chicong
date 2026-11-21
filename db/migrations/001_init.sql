-- 001_init: toàn bộ schema ban đầu
-- Tiền: INTEGER (VNĐ). Thời gian: TEXT ISO 8601 (UTC), hiển thị theo Asia/Ho_Chi_Minh.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('manager','staff')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE categories (
  id         INTEGER PRIMARY KEY,
  name_vi    TEXT NOT NULL,
  name_en    TEXT,
  name_ru    TEXT,
  name_zh    TEXT,
  icon       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE products (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name_vi     TEXT NOT NULL,
  name_en     TEXT,
  name_ru     TEXT,
  name_zh     TEXT,
  specs_vi    TEXT,
  desc_vi     TEXT,
  desc_en     TEXT,
  desc_ru     TEXT,
  desc_zh     TEXT,
  price       INTEGER,
  image_url   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved')),
  is_featured INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_products_cat_status ON products(category_id, status, is_featured);

-- KHO HÀNG THƯỜNG: mỗi dòng = 1 món (1 serial). item_code gom các món cùng loại.
CREATE TABLE inventory_items (
  id                  INTEGER PRIMARY KEY,
  item_code           TEXT,
  name                TEXT NOT NULL,
  serial              TEXT,
  import_date         TEXT,
  condition           TEXT,
  supplier            TEXT,
  warranty_in_months  INTEGER,
  tech_price          INTEGER,
  retail_price        INTEGER,
  status              TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','sold')),
  sold_date           TEXT,
  customer_name       TEXT,
  customer_phone      TEXT,
  warranty_out_months INTEGER,
  note                TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_inventory_serial ON inventory_items(serial) WHERE serial IS NOT NULL AND serial <> '';
CREATE INDEX idx_inventory_code ON inventory_items(item_code, status);
CREATE INDEX idx_inventory_status_name ON inventory_items(status, name);
CREATE INDEX idx_inventory_phone ON inventory_items(customer_phone);

CREATE TABLE tasks (
  id                   INTEGER PRIMARY KEY,
  ticket_code          TEXT NOT NULL UNIQUE,
  customer_name        TEXT,
  customer_phone       TEXT NOT NULL,
  device_model         TEXT NOT NULL,
  specs                TEXT,
  issue_desc           TEXT NOT NULL,
  estimated_price      INTEGER,
  expected_return_date TEXT,
  accessories          TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','processing','done','unrepairable','completed')),
  assigned_to          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  technician_name      TEXT,
  repair_detail        TEXT,
  replaced_parts       TEXT,
  final_price          INTEGER,
  fail_reason          TEXT,
  note                 TEXT,
  warranty_months      INTEGER,
  payment_method       TEXT CHECK (payment_method IN ('cash','transfer')),
  received_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT,
  completed_at         TEXT
);
CREATE INDEX idx_tasks_phone ON tasks(customer_phone);
CREATE INDEX idx_tasks_model ON tasks(device_model);
CREATE INDEX idx_tasks_status ON tasks(status, assigned_to);

CREATE TABLE task_histories (
  id              INTEGER PRIMARY KEY,
  task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_no      INTEGER NOT NULL,
  status          TEXT,
  technician_name TEXT,
  repair_detail   TEXT,
  replaced_parts  TEXT,
  price           INTEGER,
  fail_reason     TEXT,
  note            TEXT,
  recorded_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_task_histories_task ON task_histories(task_id);

CREATE TABLE revenues (
  id               INTEGER PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('repair','sale')),
  ref_id           INTEGER,
  customer_name    TEXT,
  customer_phone   TEXT,
  delivery_address TEXT,
  content          TEXT,
  amount           INTEGER NOT NULL DEFAULT 0,
  payment_method   TEXT NOT NULL CHECK (payment_method IN ('cash','transfer')),
  warranty_months  INTEGER,
  staff_name       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_revenues_created ON revenues(created_at);
CREATE INDEX idx_revenues_type ON revenues(type, payment_method);

-- KHO HÓA ĐƠN VAT: tách biệt hoàn toàn với kho thường
CREATE TABLE vat_invoices (
  id             INTEGER PRIMARY KEY,
  direction      TEXT NOT NULL CHECK (direction IN ('in','out')),
  drive_file_id  TEXT NOT NULL UNIQUE,
  file_name      TEXT,
  drive_link     TEXT,
  source_format  TEXT,            -- 'xml' | 'pdf' | 'image'
  invoice_symbol TEXT,            -- ký hiệu hóa đơn
  invoice_number TEXT,
  invoice_date   TEXT,
  partner_name   TEXT,
  partner_tax_id TEXT,
  total_amount   INTEGER,
  raw_json       TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_vat_invoices_dir_date ON vat_invoices(direction, invoice_date);

CREATE TABLE vat_items (
  id                 INTEGER PRIMARY KEY,
  invoice_id         INTEGER NOT NULL REFERENCES vat_invoices(id) ON DELETE CASCADE,
  item_name          TEXT NOT NULL,
  unit               TEXT,
  quantity_in        REAL NOT NULL DEFAULT 0,
  quantity_remaining REAL NOT NULL DEFAULT 0,
  unit_price         INTEGER,
  total_price        INTEGER,
  status             TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','depleted'))
);
CREATE INDEX idx_vat_items_status ON vat_items(status);

-- Lịch sử xuất mặt hàng VAT (bổ sung để đối chiếu)
CREATE TABLE vat_item_exports (
  id          INTEGER PRIMARY KEY,
  vat_item_id INTEGER NOT NULL REFERENCES vat_items(id) ON DELETE CASCADE,
  quantity    REAL NOT NULL,
  buyer_name  TEXT,
  buyer_tax_id TEXT,
  out_invoice_id INTEGER REFERENCES vat_invoices(id) ON DELETE SET NULL,
  note        TEXT,
  user_name   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Thông báo real-time cho Manager (lưu lại để xem khi mở trang sau)
CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  link       TEXT,
  actor_name TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_notifications_created ON notifications(created_at);

-- Phiên đăng nhập (thay MemoryStore)
CREATE TABLE sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires);

-- Bộ đếm sinh mã phiếu CC-YYYYMMDD-XXX
CREATE TABLE ticket_counters (
  day   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

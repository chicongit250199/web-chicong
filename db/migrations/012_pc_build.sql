-- 012: Build PC — báo giá linh kiện (nhập từ Excel, sửa trên web, AI tra thông số), liên kết kho, cấu hình đã lưu

-- Linh kiện trong báo giá
CREATE TABLE pc_parts (
  id              INTEGER PRIMARY KEY,
  category        TEXT NOT NULL,          -- nhóm như trong file: Main, CPU, RAM, Ổ Cứng, VGA, Nguồn, Vỏ Case, Màn Hình...
  name            TEXT NOT NULL,
  condition       TEXT,                   -- New / 2nd / Like New / Tray New
  price           INTEGER,                -- NULL = chưa có giá (liên hệ)
  warranty_months INTEGER,
  note            TEXT,                   -- ghi chú nội bộ
  note_public     TEXT,                   -- ghi chú hiển thị trên phiếu (VD: BH 3/2027)
  specs           TEXT,                   -- JSON thông số (AI tra / sửa tay): {"socket":"LGA1700",...}
  summary         TEXT,                   -- mô tả ngắn
  sources         TEXT,                   -- JSON [{title, uri}] nguồn AI tham khảo
  ai_at           TEXT,
  hidden          INTEGER NOT NULL DEFAULT 0,
  sort            INTEGER NOT NULL DEFAULT 0, -- thứ tự trong file
  match_key       TEXT NOT NULL,          -- nhóm|tên|tình trạng (bỏ dấu) để nhập Excel lần sau cập nhật đúng món
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_pc_parts_key ON pc_parts(match_key);
CREATE INDEX idx_pc_parts_cat ON pc_parts(category, sort);

-- Ghép hàng kho <-> linh kiện báo giá, theo tên hàng kho (bỏ dấu). part_id NULL = "bỏ qua" (không phải linh kiện PC)
CREATE TABLE pc_part_links (
  inv_key    TEXT PRIMARY KEY,
  part_id    INTEGER REFERENCES pc_parts(id) ON DELETE CASCADE,
  auto       INTEGER NOT NULL DEFAULT 0,  -- 1 = hệ thống tự ghép theo mã model
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pc_part_links_part ON pc_part_links(part_id);

-- Cấu hình đã build (báo giá cho khách / cấu hình mẫu)
CREATE TABLE pc_builds (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,    -- PC-YYMMDD-NN
  name           TEXT,
  customer_name  TEXT,
  customer_phone TEXT,
  customer_addr  TEXT,
  note           TEXT,
  items          TEXT NOT NULL,           -- JSON [{part_id, category, name, condition, price, qty, warranty_months, note}]
  discount       INTEGER NOT NULL DEFAULT 0,
  deposit        INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,  -- sau giảm giá
  is_template    INTEGER NOT NULL DEFAULT 0,
  sold_at        TEXT,
  order_code     TEXT,
  staff_name     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_pc_builds_created ON pc_builds(created_at);
CREATE INDEX idx_pc_builds_phone ON pc_builds(customer_phone);

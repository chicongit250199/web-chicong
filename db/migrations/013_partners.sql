-- 013: khách đối tác (cửa hàng gửi máy sửa): phân loại task theo tên khách / SĐT
CREATE TABLE partners (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  aliases    TEXT,            -- các cách ghi khác, mỗi dòng / dấu phẩy 1 cách
  phones     TEXT,            -- SĐT, cách nhau dấu phẩy / xuống dòng
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE tasks ADD COLUMN partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_partner ON tasks(partner_id, status);

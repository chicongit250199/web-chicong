-- 018: nhóm Zalo của khách đối tác — nhận thông báo khi bắt đầu sửa / sửa xong máy của đối tác đó
ALTER TABLE partners ADD COLUMN zalo_chat_id TEXT;
ALTER TABLE partners ADD COLUMN zalo_name TEXT;
ALTER TABLE partners ADD COLUMN zalo_enabled INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX idx_partners_zalo_chat ON partners(zalo_chat_id) WHERE zalo_chat_id IS NOT NULL;

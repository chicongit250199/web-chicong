-- 017: thông báo qua Zalo Bot — mỗi tài khoản liên kết 1 chat Zalo (nhắn mã liên kết cho bot), bật/tắt riêng
ALTER TABLE users ADD COLUMN zalo_chat_id TEXT;
ALTER TABLE users ADD COLUMN zalo_name TEXT;
ALTER TABLE users ADD COLUMN zalo_enabled INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX idx_users_zalo_chat ON users(zalo_chat_id) WHERE zalo_chat_id IS NOT NULL;

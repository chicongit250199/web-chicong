-- 014: thông báo cho cả nhân viên — audience 'all' (bán hàng, sửa chữa, nhập kho) / 'manager' (xóa, doanh thu, import...)
-- Nhân viên đánh dấu đã đọc riêng từng người (notif_seen_id), không ảnh hưởng trạng thái đọc của quản lý
ALTER TABLE notifications ADD COLUMN audience TEXT NOT NULL DEFAULT 'manager';
UPDATE notifications SET audience = 'all'
  WHERE type IN ('task_new','task_processing','task_done','task_unrepairable','task_completed','task_redo','sale');
ALTER TABLE users ADD COLUMN notif_seen_id INTEGER NOT NULL DEFAULT 0;
UPDATE users SET notif_seen_id = COALESCE((SELECT MAX(id) FROM notifications), 0);
CREATE INDEX idx_notifications_audience ON notifications(audience, id);

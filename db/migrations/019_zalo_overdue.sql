-- 019: (không còn dùng — nhắc quá hạn chuyển lại gửi 8:00 hằng ngày) cột đánh dấu đã nhắc task quá hạn qua Zalo
ALTER TABLE tasks ADD COLUMN zalo_overdue_at TEXT;

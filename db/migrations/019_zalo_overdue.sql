-- 019: nhắc task quá hạn qua Zalo ngay khi task vừa quá hạn — ghi lúc đã nhắc (task cập nhật lại thì được nhắc lần nữa nếu lại quá hạn)
ALTER TABLE tasks ADD COLUMN zalo_overdue_at TEXT;

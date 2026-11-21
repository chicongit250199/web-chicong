-- 007: chỉ mục theo ngày / tháng giờ Việt Nam cho thống kê doanh thu (biểu thức phải trùng với câu truy vấn)
CREATE INDEX idx_revenues_vn_day ON revenues(date(created_at, '+7 hours'));
CREATE INDEX idx_revenues_vn_month ON revenues(strftime('%Y-%m', created_at, '+7 hours'));
CREATE INDEX idx_tasks_completed ON tasks(status, completed_at);
CREATE INDEX idx_notifications_unread ON notifications(is_read);
ANALYZE;

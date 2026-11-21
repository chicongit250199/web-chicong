-- 011: một lần bán có nhiều món — các dòng doanh thu cùng đơn dùng chung order_code
ALTER TABLE revenues ADD COLUMN order_code TEXT;
CREATE INDEX idx_revenues_order ON revenues(order_code);

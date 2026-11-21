-- 009: liên kết sản phẩm trang chủ với kho (hiện còn hàng / hết hàng), tình trạng máy
ALTER TABLE products ADD COLUMN stock_key TEXT;    -- tên chuẩn hóa để đếm hàng tồn cùng loại
ALTER TABLE products ADD COLUMN condition TEXT;    -- Mới / Like new / Cũ
ALTER TABLE products ADD COLUMN source TEXT;       -- 'inventory' = tạo từ kho
CREATE INDEX idx_products_stock_key ON products(stock_key);

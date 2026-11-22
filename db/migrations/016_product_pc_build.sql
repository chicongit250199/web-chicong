-- 016: sản phẩm trên trang chủ lấy từ cấu hình PC mẫu (Build PC) — tự cập nhật tên / giá / cấu hình khi sửa mẫu
ALTER TABLE products ADD COLUMN pc_build_id INTEGER REFERENCES pc_builds(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_products_pc_build ON products(pc_build_id) WHERE pc_build_id IS NOT NULL;

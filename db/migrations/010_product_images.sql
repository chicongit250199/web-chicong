-- 010: nhiều ảnh cho mỗi sản phẩm (tối đa 5), ảnh đầu tiên = ảnh đại diện (products.image_url)
CREATE TABLE product_images (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,                -- nguồn gốc ảnh (trang hãng) nếu lấy từ web
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_product_images_product ON product_images(product_id, sort);
-- ảnh cũ (1 ảnh / sản phẩm) chuyển sang bảng mới
INSERT INTO product_images (product_id, url, sort) SELECT id, image_url, 0 FROM products WHERE image_url IS NOT NULL AND image_url <> '';

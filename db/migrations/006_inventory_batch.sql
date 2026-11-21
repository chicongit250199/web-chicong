-- 006: đánh dấu đợt import Excel cho kho hàng (để xóa cả đợt khi cần import lại)
ALTER TABLE inventory_items ADD COLUMN import_batch TEXT;
CREATE INDEX idx_inventory_batch ON inventory_items(import_batch);

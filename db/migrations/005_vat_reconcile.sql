-- 005: đối chiếu hóa đơn bán ra với tồn kho VAT đầu vào
ALTER TABLE vat_item_exports ADD COLUMN out_item_id INTEGER REFERENCES vat_items(id) ON DELETE CASCADE; -- dòng hàng trên HĐ bán ra
ALTER TABLE vat_item_exports ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;                            -- 1 = do đối chiếu tự động
CREATE INDEX idx_vat_exports_out_item ON vat_item_exports(out_item_id);

-- Trạng thái đối chiếu của từng dòng hàng trên HĐ bán ra
ALTER TABLE vat_items ADD COLUMN match_status TEXT;   -- NULL = chưa đối chiếu | matched | partial | unmatched | service
ALTER TABLE vat_items ADD COLUMN matched_qty REAL NOT NULL DEFAULT 0;

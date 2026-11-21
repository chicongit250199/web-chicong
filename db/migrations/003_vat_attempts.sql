-- 003: đếm số lần đọc lỗi của từng file Drive; lỗi quá 3 lần thì bỏ qua khi tự động quét
ALTER TABLE vat_drive_files ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;

-- 002: theo dõi từng file trên Drive đã xử lý (XML + PDF cùng hóa đơn, file lỗi để thử lại)
CREATE TABLE vat_drive_files (
  drive_file_id TEXT PRIMARY KEY,
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  file_name     TEXT,
  mime_type     TEXT,
  invoice_id    INTEGER REFERENCES vat_invoices(id) ON DELETE SET NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok','skipped','error')),
  error         TEXT,
  processed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

ALTER TABLE vat_invoices ADD COLUMN pdf_link TEXT;
ALTER TABLE vat_invoices ADD COLUMN seller_name TEXT;
ALTER TABLE vat_invoices ADD COLUMN seller_tax_id TEXT;
ALTER TABLE vat_invoices ADD COLUMN buyer_name TEXT;
ALTER TABLE vat_invoices ADD COLUMN buyer_tax_id TEXT;
ALTER TABLE vat_invoices ADD COLUMN vat_amount INTEGER;
ALTER TABLE vat_invoices ADD COLUMN subtotal INTEGER;
CREATE INDEX idx_vat_invoices_key ON vat_invoices(partner_tax_id, invoice_symbol, invoice_number);

ALTER TABLE vat_items ADD COLUMN vat_rate TEXT;

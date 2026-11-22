-- 015: nhân viên gửi yêu cầu nhập hàng cho linh kiện trong bảng Giá Linh Kiện -> trạng thái "Chờ nhập kho"
-- Tự gỡ khi hàng về (tồn kho lớn hơn lúc yêu cầu) hoặc quản lý hủy yêu cầu
ALTER TABLE pc_parts ADD COLUMN req_at TEXT;
ALTER TABLE pc_parts ADD COLUMN req_by TEXT;          -- tên nhân viên yêu cầu
ALTER TABLE pc_parts ADD COLUMN req_qty INTEGER;
ALTER TABLE pc_parts ADD COLUMN req_note TEXT;
ALTER TABLE pc_parts ADD COLUMN req_stock INTEGER;    -- tồn kho lúc yêu cầu

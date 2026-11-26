-- Tình trạng hàng trong kho chỉ còn 3 giá trị: New / 2nd / Like New
UPDATE inventory_items SET condition = 'New'      WHERE UPPER(TRIM(condition)) IN ('NEW', 'MỚI', 'MOI', 'TRAY NEW') OR TRIM(condition) IN ('Mới', 'mới');
UPDATE inventory_items SET condition = '2nd'      WHERE UPPER(TRIM(condition)) IN ('2ND', 'CŨ', 'CU', 'USED', 'ĐÃ QUA SỬ DỤNG') OR TRIM(condition) IN ('Cũ', 'cũ', 'Đã qua sử dụng');
UPDATE inventory_items SET condition = 'Like New' WHERE UPPER(TRIM(condition)) IN ('LIKE NEW', 'LIKENEW');
UPDATE inventory_items SET condition = NULL       WHERE TRIM(condition) = '';

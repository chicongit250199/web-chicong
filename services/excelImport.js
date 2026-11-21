'use strict';
// Đọc file Excel kho cũ (15 cột) -> danh sách dòng chuẩn hóa + phân loại tồn kho / đã bán
const XLSX = require('xlsx');
const inv = require('./inventory');

// Tên cột (bỏ dấu, viết thường, bỏ khoảng trắng) -> trường
const COLUMNS = {
  item_code: ['sku', 'ma', 'mahang', 'id', 'mahh'],
  name: ['tenlinhkien', 'tenhang', 'tenhanghoa', 'ten', 'tensanpham'],
  serial: ['soserrial', 'soserial', 'serial', 'serrial', 'sn', 'soseri'],
  import_date: ['ngaynhap'],
  condition: ['tinhtrang'],
  supplier: ['npp', 'nhaphanphoi', 'nhacungcap', 'ncc'],
  warranty_in_months: ['thbhnhap', 'baohanhnhap'],
  sold_date: ['ngayban', 'ngayxuat', 'ngayxuatban', 'ngayxuathang'],
  customer_name: ['tenkh', 'tenkhachhang', 'khachhang'],
  customer_phone: ['sdtkh', 'sdt', 'sodienthoai', 'dienthoai'],
  warranty_out_months: ['thbhxuat', 'baohanhxuat'],
  note: ['ghichu'],
  tech_price: ['giakt', 'giakythuat', 'gianhap'],
  retail_price: ['giabanle', 'giaban'],
};
const norm = s => inv.stripVi(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function mapHeader(row) {
  const map = {};
  row.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    for (const [field, names] of Object.entries(COLUMNS)) {
      if (map[field] === undefined && names.includes(n)) { map[field] = i; return; }
    }
  });
  return map;
}

function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const rows = [];
  const warnings = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws['!ref']) continue;
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    // Tìm dòng tiêu đề trong 10 dòng đầu
    let headerIdx = -1; let map = null;
    for (let i = 0; i < Math.min(10, aoa.length); i++) {
      const m = mapHeader(aoa[i] || []);
      if (m.name !== undefined && (m.serial !== undefined || m.item_code !== undefined)) { headerIdx = i; map = m; break; }
    }
    if (headerIdx < 0) { warnings.push(`Sheet "${sheetName}": không tìm thấy dòng tiêu đề (cần cột Tên Linh Kiện + Số Serial/SKU)`); continue; }

    for (let r = headerIdx + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const get = f => (map[f] === undefined ? null : row[map[f]]);
      const name = get('name') == null ? '' : String(get('name')).trim();
      if (!name) continue;
      const serial = get('serial') == null ? '' : String(get('serial')).trim();
      const soldDate = inv.parseDate(get('sold_date'));
      const customer = get('customer_name') == null ? '' : String(get('customer_name')).trim();
      // ĐÃ BÁN = ô "Ngày bán" KHÔNG TRỐNG. Cột "Đã Bán" (chỉ tô màu để nhận biết) được bỏ qua.
      const rawSold = get('sold_date') == null ? '' : String(get('sold_date')).trim();
      const sold = rawSold !== '';
      // Ghi gì đó nhưng không phải ngày (VD "đã bán") -> vẫn là đã bán, ngày bán để trống
      const hint = sold && !soldDate ? `Ngày bán "${rawSold}" không phải ngày — vẫn tính đã bán, ngày bán để trống` : null;
      rows.push({
        sheet: sheetName, line: r + 1,
        item_code: get('item_code') == null || get('item_code') === '' ? inv.makeItemCode(name) : String(get('item_code')).trim(),
        name, serial: serial || null,
        import_date: inv.parseDate(get('import_date')),
        condition: get('condition') == null ? null : String(get('condition')).trim(),
        supplier: get('supplier') == null ? null : String(get('supplier')).trim(),
        warranty_in_months: inv.parseWarrantyMonths(get('warranty_in_months')),
        tech_price: inv.parseMoney(get('tech_price')),
        retail_price: inv.parseMoney(get('retail_price')),
        status: sold ? 'sold' : 'in_stock',
        hint,
        sold_date: soldDate,
        customer_name: customer || null,
        customer_phone: get('customer_phone') == null ? null : String(get('customer_phone')).replace(/[^\d+]/g, '') || null,
        warranty_out_months: inv.parseWarrantyMonths(get('warranty_out_months')),
        note: get('note') == null ? null : String(get('note')).trim(),
      });
    }
  }

  // Chống trùng Serial: trong file và với dữ liệu đã có
  const seen = new Map();
  for (const r of rows) {
    if (!r.serial) continue;
    if (seen.has(r.serial)) { r.duplicate = `Trùng với dòng ${seen.get(r.serial)} trong file`; continue; }
    seen.set(r.serial, `${r.sheet}:${r.line}`);
  }
  const existing = new Map(inv.existingSerials([...seen.keys()]).map(e => [e.serial, e]));
  for (const r of rows) if (r.serial && !r.duplicate && existing.has(r.serial)) r.duplicate = 'Serial đã có trong kho';
  const hinted = rows.filter(r => r.hint && !r.duplicate).length;
  if (hinted) warnings.push(`${hinted} dòng có ô Ngày bán ghi chữ thay vì ngày → vẫn tính là đã bán nhưng không có ngày bán (tô vàng, lọc "cần kiểm tra"). Muốn có ngày bán / hạn bảo hành thì sửa ô đó thành ngày rồi tải lại.`);
  return { rows, warnings };
}

module.exports = { parseWorkbook, COLUMNS };

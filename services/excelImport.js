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
  sold_flag: ['daban'],
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

// Ô được tô màu nền (không trắng/không trống) -> coi như đánh dấu
function hasFill(cell) {
  const s = cell && cell.s;
  if (!s || s.patternType !== 'solid' || !s.fgColor) return false;
  const rgb = String(s.fgColor.rgb || '').toUpperCase();
  if (rgb) return rgb !== 'FFFFFF' && rgb !== 'FFFFFFFF';
  return s.fgColor.theme !== undefined && s.fgColor.theme !== 0; // theme 0 = trắng
}

function isSoldFlag(v) {
  if (v == null) return false;
  const s = norm(v);
  if (!s) return false;
  return !['0', 'khong', 'no', 'false', 'chuaban', 'con', 'tonkho'].includes(s);
}

function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellStyles: true });
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
    const range = XLSX.utils.decode_range(ws['!ref']);

    for (let r = headerIdx + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const get = f => (map[f] === undefined ? null : row[map[f]]);
      const name = get('name') == null ? '' : String(get('name')).trim();
      if (!name) continue;
      const serial = get('serial') == null ? '' : String(get('serial')).trim();
      const soldCell = map.sold_flag !== undefined ? ws[XLSX.utils.encode_cell({ r: r + range.s.r, c: map.sold_flag + range.s.c })] : null;
      const soldDate = inv.parseDate(get('sold_date'));
      const customer = get('customer_name') == null ? '' : String(get('customer_name')).trim();
      // Hàng đã xuất = dòng có NGÀY XUẤT (Ngày bán). Đánh dấu / tên KH mà thiếu ngày -> vẫn tồn kho, nhắc kiểm tra.
      const sold = Boolean(soldDate);
      const rawSold = get('sold_date');
      const marked = isSoldFlag(get('sold_flag')) || hasFill(soldCell) || Boolean(customer);
      const hint = !sold && rawSold != null && String(rawSold).trim() !== '' ? `Ngày xuất "${String(rawSold).trim()}" không đọc được`
        : !sold && marked ? 'Có đánh dấu đã bán / tên KH nhưng thiếu ngày xuất' : null;
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
  if (hinted) warnings.push(`${hinted} dòng có đánh dấu đã bán / tên khách nhưng không có ngày xuất → đang để ở Tồn kho (tô vàng bên dưới, lọc "Cần kiểm tra"). Nếu đã bán, điền ngày xuất trong file rồi tải lại.`);
  return { rows, warnings };
}

module.exports = { parseWorkbook, COLUMNS };

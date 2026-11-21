'use strict';
// Build PC: nhóm linh kiện, trường thông số, ghép kho <-> báo giá, đọc file Excel báo giá, đọc số thành chữ
const XLSX = require('xlsx');
const db = require('../db');
const inv = require('./inventory');

const vn = s => db.vn(String(s || '')).replace(/\s+/g, ' ').trim();

// ---- Loại linh kiện (suy ra từ tên nhóm trong file) ----
const TYPES = [
  ['cpu', /\bcpu\b|vi xu ly/],
  ['main', /\bmain|bo mach/],
  ['ram', /\bram\b/],
  ['vga', /\bvga\b|card do hoa|\bgpu\b/],
  ['storage', /o cung|\bssd\b|\bhdd\b|luu tru/],
  ['psu', /nguon|\bpsu\b/],
  ['cooler', /tan nhiet|\btan\b|cooler/],
  ['case', /\bcase\b|\bvo\b/],
  ['monitor', /man hinh|monitor/],
  ['keyboard', /ban phim|keyboard/],
  ['mouse', /chuot|mouse/],
];
function typeOf(category) {
  const c = vn(category);
  const t = TYPES.find(([, re]) => re.test(c));
  return t ? t[0] : 'other';
}
// Thứ tự hiển thị khi build
const TYPE_ORDER = ['cpu', 'main', 'ram', 'vga', 'storage', 'psu', 'case', 'cooler', 'monitor', 'keyboard', 'mouse', 'other'];

// ---- Thông số theo loại: [key, nhãn, gợi ý cho AI] ----
const FIELDS = {
  cpu: [['socket', 'Socket', 'VD: LGA1700, LGA1200, AM4, AM5'], ['cores', 'Nhân / Luồng', 'VD: 6 nhân / 12 luồng'], ['clock', 'Xung nhịp', 'cơ bản / boost'],
    ['igpu', 'GPU tích hợp', 'tên GPU, hoặc "Không" với dòng F/KF'], ['tdp_w', 'TDP (W)', 'chỉ số W'], ['ram_support', 'RAM hỗ trợ', 'DDR4 / DDR5']],
  main: [['socket', 'Socket', 'VD: LGA1700, AM4'], ['chipset', 'Chipset', 'VD: B760'], ['ram_type', 'Loại RAM', 'DDR4 hoặc DDR5'], ['ram_slots', 'Số khe RAM', 'số'],
    ['form_factor', 'Kích thước', 'ATX / M-ATX / ITX'], ['m2_slots', 'Khe M.2', 'số khe và chuẩn'], ['wifi', 'Wifi / Bluetooth', 'Có/Không']],
  ram: [['ram_type', 'Loại RAM', 'DDR3 / DDR4 / DDR5'], ['capacity', 'Dung lượng', 'VD: 16GB'], ['bus', 'Bus', 'VD: 3200MHz'], ['form', 'Dùng cho', 'PC (DIMM) / Laptop (SODIMM)']],
  vga: [['gpu', 'Chip đồ họa', 'VD: RTX 3060'], ['vram', 'Bộ nhớ', 'VD: 12GB GDDR6'], ['power_w', 'Công suất tiêu thụ (W)', 'chỉ số W'],
    ['psu_w', 'Nguồn khuyến nghị (W)', 'chỉ số W'], ['length_mm', 'Chiều dài (mm)', 'chỉ số mm'], ['outputs', 'Cổng xuất hình', 'HDMI / DP...']],
  storage: [['interface', 'Chuẩn', 'SATA / NVMe PCIe Gen3 / Gen4'], ['capacity', 'Dung lượng', 'VD: 512GB'], ['speed', 'Tốc độ đọc / ghi', 'MB/s'], ['form', 'Dạng', '2.5" / M.2 2280 / 3.5"']],
  psu: [['watt', 'Công suất (W)', 'chỉ số W'], ['efficiency', 'Chuẩn hiệu suất', 'VD: 80 Plus Bronze'], ['modular', 'Dây rời', 'Full / Semi / Không'], ['connectors', 'Đầu cấp nguồn', 'CPU 8pin, PCIe...']],
  case: [['form_factors', 'Hỗ trợ main', 'ATX / M-ATX / ITX'], ['fans', 'Fan kèm theo', 'số fan'], ['gpu_max_mm', 'VGA dài tối đa (mm)', 'mm'], ['cooler_max_mm', 'Tản cao tối đa (mm)', 'mm']],
  cooler: [['kind', 'Loại', 'Tản khí / AIO 240...'], ['sockets', 'Socket hỗ trợ', 'LGA1700, AM4...'], ['height_mm', 'Chiều cao (mm)', 'mm'], ['tdp_w', 'TDP hỗ trợ (W)', 'W']],
  monitor: [['size', 'Kích thước', 'inch'], ['resolution', 'Độ phân giải', 'FHD / QHD / 4K'], ['refresh', 'Tần số quét', 'Hz'], ['panel', 'Tấm nền', 'IPS / VA / TN'], ['response', 'Phản hồi', 'ms'], ['ports', 'Cổng kết nối', 'HDMI, DP...']],
  keyboard: [['connection', 'Kết nối', 'Có dây / Không dây / Bluetooth'], ['switch', 'Switch', 'cơ / màng, loại switch'], ['layout', 'Layout', 'Fullsize / TKL...'], ['led', 'LED', 'RGB / đơn sắc / không']],
  mouse: [['connection', 'Kết nối', 'Có dây / Không dây'], ['dpi', 'DPI', 'số'], ['sensor', 'Cảm biến', ''], ['led', 'LED', 'RGB / không']],
  other: [['highlights', 'Thông số chính', 'tối đa 3-4 ý ngắn']],
};
const fieldsOf = category => FIELDS[typeOf(category)] || FIELDS.other;

// ---- Tình trạng: chuẩn hóa để so sánh kho <-> báo giá ----
function condKind(s) {
  const c = vn(s);
  if (!c) return '';
  if (/like|2nd|cu|used|qua su dung|da qua|tray/.test(c) && !/tray new/.test(c)) return 'used';
  if (/new|moi/.test(c)) return 'new';
  return '';
}

const matchKey = (category, name, condition) => [category, name, condition].map(vn).join('|');
const invKey = name => vn(name);
const displayName = p => `${p.name}${p.condition ? ` (${p.condition})` : ''}`;

// ---- Mã model trong tên: các cụm có chữ số, bỏ gạch nối ("H510M-K" -> "h510mk", "i3-7100" -> "i37100") ----
function modelTokens(name) {
  return new Set(vn(name).replace(/(\w)\s*-\s*(\w)/g, '$1$2').split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && /\d/.test(t) && !/^\d+(gb?|tb|w|hz|mhz|mm|inch|in|k)?$/.test(t) && !/^(ddr\d|gen\d|pcie\d|usb\d|ddr\d\d+)$/.test(t)));
}

// Gợi ý món báo giá cho 1 tên hàng kho: điểm = tỉ lệ mã model khớp
function suggest(invName, invCond, parts, limit = 3) {
  const it = modelTokens(invName);
  const exact = vn(invName);
  const scored = [];
  for (const p of parts) {
    if (vn(p.name) === exact) { scored.push({ part: p, score: 2 }); continue; }
    if (!it.size) continue;
    const pt = modelTokens(p.name);
    let hit = 0; it.forEach(t => { if (pt.has(t)) hit++; });
    if (!hit) continue;
    let score = hit / Math.min(it.size, pt.size || 1);
    const a = condKind(invCond); const b = condKind(p.condition);
    if (a && b) score += a === b ? 0.2 : -0.5;
    scored.push({ part: p, score });
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, limit);
}

// ---- Tồn kho theo linh kiện ----
const qStockGroups = db.prepare(`SELECT name, MAX(condition) AS condition, MAX(item_code) AS item_code, COUNT(*) AS qty, MAX(retail_price) AS retail_price,
    MAX(warranty_out_months) AS warranty_out_months FROM inventory_items WHERE status = 'in_stock' GROUP BY name ORDER BY name`);
const qLinks = db.prepare('SELECT inv_key, part_id, auto FROM pc_part_links');

// -> { byPart: Map(part_id -> {qty, names:[]}), unlinked: [{name, condition, qty, ...}] }
function stockInfo() {
  const links = new Map(qLinks.all().map(l => [l.inv_key, l]));
  const byPart = new Map();
  const unlinked = [];
  const seen = new Map(); // gộp tên khác hoa/thường
  for (const g of qStockGroups.all()) {
    const key = invKey(g.name);
    const l = links.get(key);
    if (l) {
      if (l.part_id == null) continue; // đã bỏ qua
      const s = byPart.get(l.part_id) || { qty: 0, names: [] };
      s.qty += g.qty; s.names.push(g.name);
      byPart.set(l.part_id, s);
    } else if (seen.has(key)) {
      seen.get(key).qty += g.qty;
    } else {
      const u = { ...g, key };
      seen.set(key, u); unlinked.push(u);
    }
  }
  return { byPart, unlinked };
}

// Tên hàng kho đang ghép với 1 linh kiện
const qPartInvKeys = db.prepare('SELECT inv_key FROM pc_part_links WHERE part_id = ?');
function stockUnits(partId) {
  const keys = new Set(qPartInvKeys.all(partId).map(r => r.inv_key));
  if (!keys.size) return [];
  return db.prepare(`SELECT id, item_code, name, serial, condition, retail_price, warranty_out_months, import_date FROM inventory_items
      WHERE status = 'in_stock' ORDER BY import_date, id`).all().filter(u => keys.has(invKey(u.name)));
}

const insLink = db.prepare(`INSERT INTO pc_part_links (inv_key, part_id, auto) VALUES (?, ?, ?)
    ON CONFLICT(inv_key) DO UPDATE SET part_id = excluded.part_id, auto = excluded.auto`);
function link(invName, partId, auto = false) { insLink.run(invKey(invName), partId ?? null, auto ? 1 : 0); }

// Tự ghép hàng kho chưa ghép khi chắc chắn: trùng tên, hoặc trùng hết mã model + cùng tình trạng, và chỉ 1 ứng viên tốt nhất
function autoLink() {
  const parts = db.prepare('SELECT id, name, condition FROM pc_parts').all();
  const { unlinked } = stockInfo();
  let n = 0;
  db.transaction(() => {
    for (const u of unlinked) {
      const s = suggest(u.name, u.condition, parts, 2);
      if (!s.length) continue;
      const [a, b] = s;
      const sure = a.score >= 2 || (a.score >= 1.2 && condKind(u.condition) && (!b || b.score < a.score));
      if (sure) { link(u.name, a.part.id, true); n++; }
    }
  })();
  return n;
}

// ---- Đọc file Excel báo giá (sheet có tiêu đề "Tên LK" + "Giá") ----
const H = {
  category: ['nhom', 'loai', 'nhomhang', 'danhmuc'],
  name: ['tenlk', 'tenlinhkien', 'ten', 'tenhang', 'sanpham'],
  condition: ['tinhtrang'],
  price: ['gia', 'giaban', 'dongia', 'giabanle'],
  warranty: ['baohanh', 'bh', 'thbh'],
  note: ['ghichu'],
  note_public: ['ghichuhienthi'],
};
const hnorm = s => vn(s).replace(/[^a-z0-9]/g, '');

function parsePriceWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const warnings = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
    const hi = rows.findIndex(r => r.some(c => H.name.includes(hnorm(c))) && r.some(c => H.price.includes(hnorm(c))));
    if (hi < 0) continue;
    const head = rows[hi].map(hnorm);
    const col = {};
    for (const [f, names] of Object.entries(H)) { const i = head.findIndex(h => names.includes(h)); if (i >= 0) col[f] = i; }
    // File mẫu: ô "Tên LK" gộp 2 cột (A = nhóm, B = tên) -> cột kế bên trống
    if (col.category == null && col.name != null && head[col.name + 1] === '') { col.category = col.name; col.name += 1; }
    const out = [];
    let cat = '';
    rows.slice(hi + 1).forEach((r, i) => {
      if (col.category != null && String(r[col.category]).trim()) cat = String(r[col.category]).trim();
      const name = String(r[col.name] ?? '').replace(/\s+/g, ' ').trim();
      if (!name) return;
      const condition = col.condition != null ? String(r[col.condition] ?? '').trim() || null : null;
      const price = col.price != null ? inv.parseMoney(r[col.price]) : null;
      out.push({
        line: hi + i + 2, category: cat || 'Khác', name, condition,
        price: price && price > 0 ? price : null,
        warranty_months: col.warranty != null ? inv.parseWarrantyMonths(r[col.warranty]) : null,
        note: col.note != null ? String(r[col.note] ?? '').trim() || null : null,
        note_public: col.note_public != null ? String(r[col.note_public] ?? '').trim() || null : null,
      });
    });
    // trùng nhóm + tên + tình trạng trong file -> giữ dòng sau cùng
    const byKey = new Map();
    out.forEach((r, i) => { r.sort = i; r.match_key = matchKey(r.category, r.name, r.condition); if (byKey.has(r.match_key)) warnings.push(`Dòng ${r.line}: "${r.name}" trùng dòng ${byKey.get(r.match_key).line}, lấy dòng sau.`); byKey.set(r.match_key, r); });
    return { sheet: sheetName, rows: [...byKey.values()], warnings };
  }
  throw new Error('Không tìm thấy sheet có cột "Tên LK" và "Giá".');
}

// ---- Đọc số tiền thành chữ ----
const VN_DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
function vnTriple(n, full) {
  const tr = Math.floor(n / 100); const ch = Math.floor((n % 100) / 10); const dv = n % 10;
  const w = [];
  if (full || tr) w.push(VN_DIGITS[tr], 'trăm');
  if (ch > 1) { w.push(VN_DIGITS[ch], 'mươi'); if (dv === 1) w.push('mốt'); else if (dv === 4) w.push('tư'); else if (dv === 5) w.push('lăm'); else if (dv) w.push(VN_DIGITS[dv]); }
  else if (ch === 1) { w.push('mười'); if (dv === 5) w.push('lăm'); else if (dv) w.push(VN_DIGITS[dv]); }
  else if (dv) { if (full || tr) w.push('lẻ'); w.push(VN_DIGITS[dv]); }
  return w.join(' ');
}
// đọc phần < 1 tỷ; full = đã có hàng cao hơn phía trước (để đọc "không trăm", "lẻ")
function vnUnder1e9(n, full) {
  const groups = [Math.floor(n / 1e6), Math.floor(n / 1000) % 1000, n % 1000];
  const units = ['triệu', 'nghìn', ''];
  const out = [];
  groups.forEach((g, i) => { if (!g) return; out.push(vnTriple(g, full) + (units[i] ? ' ' + units[i] : '')); full = true; });
  return out.join(' ');
}
function vnRead(n) {
  if (n >= 1e9) { const lo = n % 1e9; return vnRead(Math.floor(n / 1e9)) + ' tỷ' + (lo ? ' ' + vnUnder1e9(lo, true) : ''); }
  return vnUnder1e9(n, false);
}
function vnWords(num) {
  const n = Math.round(Math.abs(Number(num) || 0));
  if (!n) return 'Không đồng.';
  const s = vnRead(n).replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1) + ' đồng.';
}
const EN_ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function enTriple(n) {
  const w = [];
  if (n >= 100) { w.push(EN_ONES[Math.floor(n / 100)], 'hundred'); n %= 100; }
  if (n >= 20) { w.push(EN_TENS[Math.floor(n / 10)] + (n % 10 ? '-' + EN_ONES[n % 10] : '')); } else if (n) w.push(EN_ONES[n]);
  return w.join(' ');
}
function enWords(num) {
  let n = Math.round(Math.abs(Number(num) || 0));
  if (!n) return 'Zero dong.';
  const units = ['', 'thousand', 'million', 'billion'];
  const parts = []; let i = 0;
  while (n > 0) { const g = n % 1000; if (g) parts.unshift(enTriple(g) + (units[i] ? ' ' + units[i] : '')); n = Math.floor(n / 1000); i++; }
  const s = parts.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + ' dong.';
}

module.exports = {
  vn, typeOf, TYPE_ORDER, TYPES_SRC: TYPES.map(([t, re]) => [t, re.source]), FIELDS, fieldsOf, condKind, matchKey, invKey, displayName, modelTokens, suggest,
  stockInfo, stockUnits, link, autoLink, parsePriceWorkbook, vnWords, enWords,
};

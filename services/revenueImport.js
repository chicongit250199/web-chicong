'use strict';
// Đọc file Excel doanh thu cũ: THÁNG | NGÀY | NỘI DUNG | SDT KHÁCH | THU | CHI | GHI CHÚ
// - Ô NGÀY/THÁNG gộp nhiều dòng -> lấy ngày gần nhất phía trên
// - THU = doanh thu (nhập), CHI = tiền chi ra (không nhập, chỉ thống kê)
// - Số tiền thường ghi theo nghìn đồng (900 = 900.000đ) -> tự nhận diện
const XLSX = require('xlsx');
const db = require('../db');
const inv = require('./inventory');

const COLUMNS = {
  date: ['ngay', 'ngaythang', 'date'],
  content: ['noidung', 'diengiai', 'noidungthu', 'mathang', 'tenhang'],
  phone: ['sdtkhach', 'sdt', 'sdtkh', 'sodienthoai', 'dienthoai'],
  customer: ['tenkhach', 'khachhang', 'tenkh'],
  income: ['thu', 'tienthu', 'doanhthu', 'sotien'],
  expense: ['chi', 'tienchi'],
  note: ['ghichu', 'note'],
  payment: ['hinhthuc', 'thanhtoan', 'httt'],
};
const norm = s => inv.stripVi(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function mapHeader(row) {
  const map = {};
  row.forEach((h, i) => {
    const n = norm(h);
    for (const [f, names] of Object.entries(COLUMNS)) if (map[f] === undefined && names.includes(n)) map[f] = i;
  });
  return map;
}

// Sửa chữa / dịch vụ nếu nội dung có các từ này, còn lại coi là bán hàng
const REPAIR = /\b(sua|thay|vs|ve sinh|cai (win|dat|lai|phan mem|office|driver|may)|nap|cuu du lieu|ep|reset|kiem tra|bao hanh|thao|chay lai|flash|bios|unlock|mo khoa|cong sua|tien cong)\b/;
function guessType(content) { return REPAIR.test(inv.stripVi(content).toLowerCase()) ? 'repair' : 'sale'; }

const TRANSFER = /(^|[^a-z])(ck|chuyen khoan|bank|stk|tk)([^a-z]|$)/;
function guessPayment(...texts) {
  return texts.some(t => t && TRANSFER.test(inv.stripVi(String(t)).toLowerCase())) ? 'transfer' : 'cash';
}

function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  return inv.parseMoney(v);
}

function parseRevenueWorkbook(buffer, { unit = 'auto' } = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const rows = [];
  const warnings = [];
  let expense = { count: 0, total: 0 };
  const noContent = { count: 0, total: 0 }; // dòng có tiền nhưng trống NỘI DUNG -> bỏ qua
  const expenses = []; // các dòng có cột CHI
  const sheetsUsed = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws['!ref']) continue;
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    let headerIdx = -1; let map = null;
    for (let i = 0; i < Math.min(15, aoa.length); i++) {
      const m = mapHeader(aoa[i] || []);
      if (m.date !== undefined && m.content !== undefined && m.income !== undefined) { headerIdx = i; map = m; break; }
    }
    if (headerIdx < 0) continue; // VD sheet "Tổng hợp"
    sheetsUsed.push(sheetName);

    let curDate = null;
    for (let r = headerIdx + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const get = f => (map[f] === undefined ? null : row[map[f]]);
      const d = inv.parseDate(get('date'));
      if (d) curDate = d;
      const content = get('content') == null ? '' : String(get('content')).trim();
      const income = toNumber(get('income'));
      const exp = toNumber(get('expense'));
      if (!content && income == null && exp == null) continue;
      // Chỉ lấy dòng có NỘI DUNG (dòng trống nội dung thường là dòng cộng / ghi tạm)
      if (!content) { if (income) { noContent.count++; noContent.total += income; } continue; }
      if (/^(tong|cong)\b/.test(inv.stripVi(content).toLowerCase())) continue; // dòng tổng cộng
      const note = get('note') == null ? '' : String(get('note')).trim();
      // Cột CHI -> danh sách chi phí (nhập vào mục Chi phí)
      if (exp) {
        expense.count++; expense.total += exp;
        expenses.push({ line: r + 1, date: curDate, content, rawAmount: exp, note: note || null,
          payment: guessPayment(content, note), problem: curDate ? null : 'Không có ngày',
          saveContent: [content, note].filter(Boolean).join(' — ').slice(0, 1000) });
      }
      if (income == null || income === 0) continue;
      const phoneRaw = get('phone');
      rows.push({
        sheet: sheetName, line: r + 1, date: curDate, content,
        phone: phoneRaw == null ? null : String(phoneRaw).replace(/[^\d+]/g, '') || null,
        customer: get('customer') == null ? null : String(get('customer')).trim() || null,
        rawAmount: income, note: note || null,
        type: guessType(content), payment: map.payment !== undefined && get('payment') ? guessPayment(get('payment')) : guessPayment(content, note),
        problem: curDate ? null : 'Không có ngày',
      });
      // Nội dung lưu vào doanh thu (kèm ghi chú) — dùng chung cho lưu và so trùng
      rows[rows.length - 1].saveContent = [rows[rows.length - 1].content, note].filter(Boolean).join(' — ').slice(0, 1000);
    }
  }
  if (!sheetsUsed.length) warnings.push('Không tìm thấy sheet có cột NGÀY + NỘI DUNG + THU.');

  // Đơn vị: nếu phần lớn số tiền < 100.000 thì file ghi theo nghìn đồng
  const amounts = rows.map(r => r.rawAmount).filter(a => a > 0).sort((a, b) => a - b);
  const median = amounts.length ? amounts[Math.floor(amounts.length / 2)] : 0;
  const factor = unit === 'thousand' ? 1000 : unit === 'vnd' ? 1 : (median && median < 100000 ? 1000 : 1);
  for (const r of rows) r.amount = Math.round(r.rawAmount * factor);
  expense.total = Math.round(expense.total * factor);
  for (const e of expenses) e.amount = Math.round(e.rawAmount * factor);
  noContent.total = Math.round(noContent.total * factor);

  // Chống trùng: trong file và với doanh thu đã nhập từ Excel trước đó (cùng ngày + nội dung + số tiền)
  const existing = db.prepare(`SELECT date(created_at, '+7 hours') AS d, content, amount FROM revenues WHERE source = 'excel'`).all();
  const seen = new Set(existing.map(e => `${e.d}|${e.content}|${e.amount}`));
  // (trong cùng 1 file, cùng ngày bán 2 món giống hệt là hợp lệ -> không coi là trùng)
  for (const r of rows) {
    if (!r.problem && seen.has(`${r.date}|${r.saveContent}|${r.amount}`)) r.duplicate = 'Đã nhập trước đó';
  }
  // Chi phí: chống trùng với các khoản chi đã nhập từ Excel trước đó
  const seenExp = new Set(db.prepare(`SELECT expense_date, content, amount FROM expenses WHERE source = 'excel'`).all().map(e => `${e.expense_date}|${e.content}|${e.amount}`));
  for (const e of expenses) if (!e.problem && seenExp.has(`${e.date}|${e.saveContent}|${e.amount}`)) e.duplicate = 'Đã nhập trước đó';
  expense.new = expenses.filter(e => !e.duplicate && !e.problem).length;
  expense.newTotal = expenses.filter(e => !e.duplicate && !e.problem).reduce((t, e) => t + e.amount, 0);
  return { rows, warnings, expense, expenses, noContent, factor, sheetsUsed, median };
}

module.exports = { parseRevenueWorkbook, guessType, guessPayment };

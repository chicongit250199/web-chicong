'use strict';
// Đồng bộ dữ liệu web -> Google Sheet (1 chiều, ghi đè toàn bộ các trang tính do web quản lý).
// Dùng tài khoản dịch vụ (credentials/service-account.json) — file Sheet phải được chia sẻ quyền chỉnh sửa cho email của nó.
// Cấu hình trong bảng settings: gsheet_id, gsheet_from (doanh thu / chi phí từ ngày), gsheet_sync_at (giờ tự đồng bộ hằng ngày).
const fs = require('fs');
const db = require('../db');
const config = require('../config');
const settings = require('./settings');
const fmt = require('./format');

const env = process.env;
const DEFAULT_FROM = '2026-11-01';
const DEFAULT_AT = '00:00';

const state = { enabled: false, running: false, at: DEFAULT_AT, nextRunAt: null };
let timer = null, catchUp = null, client = null;

// ---------- cấu hình ----------
function serviceEmail() {
  try { return JSON.parse(fs.readFileSync(config.googleServiceAccountPath, 'utf8')).client_email || ''; } catch { return ''; }
}
function parseId(s) {
  const v = String(s || '').trim();
  const m = v.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/) || v.match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : null;
}
function cfg() {
  return {
    id: settings.get('gsheet_id') || '',
    from: settings.get('gsheet_from') || DEFAULT_FROM,
    at: settings.get('gsheet_sync_at') || DEFAULT_AT,
  };
}
function lastRun() { try { return JSON.parse(settings.get('gsheet_last') || 'null'); } catch { return null; } }

function sheetsApi() {
  if (client) return client;
  const { sheets, auth } = require('@googleapis/sheets');
  const cred = JSON.parse(fs.readFileSync(config.googleServiceAccountPath, 'utf8'));
  const a = new auth.JWT({ email: cred.client_email, key: cred.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  client = sheets({ version: 'v4', auth: a });
  return client;
}

// ---------- dữ liệu ----------
// Ngày giờ ghi dạng dd/mm/yyyy (file Sheet đặt khu vực Việt Nam -> Sheet hiểu là ngày, lọc / sắp xếp được)
const dmy = ymd => { const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const vnTime = iso => { if (!iso) return ''; const t = new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString(); return `${dmy(t)} ${t.slice(11, 16)}`; };
const VN_DAY = "date(created_at, '+7 hours')";
const pay = p => fmt.payment(p);

function buildTabs(from) {
  const rev = db.prepare(`SELECT * FROM revenues WHERE ${VN_DAY} >= ? ORDER BY created_at, id`).all(from);
  const exp = db.prepare('SELECT * FROM expenses WHERE expense_date >= ? ORDER BY expense_date, id').all(from);
  const months = db.prepare(`
    SELECT m, SUM(n) n, SUM(cash) cash, SUM(transfer) transfer, SUM(debt) debt, SUM(repair) repair, SUM(sale) sale, SUM(thu) thu, SUM(chi) chi, SUM(paid) paid FROM (
      SELECT substr(${VN_DAY}, 1, 7) m, COUNT(*) n,
        SUM(CASE WHEN payment_method = 'cash' THEN amount ELSE 0 END) cash, SUM(CASE WHEN payment_method = 'transfer' THEN amount ELSE 0 END) transfer,
        SUM(CASE WHEN payment_method = 'debt' THEN amount ELSE 0 END) debt,
        SUM(CASE WHEN type = 'repair' THEN amount ELSE 0 END) repair, SUM(CASE WHEN type = 'sale' THEN amount ELSE 0 END) sale, SUM(amount) thu, 0 chi, 0 paid
      FROM revenues WHERE ${VN_DAY} >= ? GROUP BY m
      UNION ALL
      SELECT substr(expense_date, 1, 7) m, 0, 0, 0, 0, 0, 0, 0, SUM(amount), 0 FROM expenses WHERE expense_date >= ? GROUP BY m
      UNION ALL
      SELECT substr(${VN_DAY}, 1, 7) m, 0, 0, 0, 0, 0, 0, 0, 0, SUM(amount) FROM debt_payments WHERE ${VN_DAY} >= ? GROUP BY m
    ) GROUP BY m ORDER BY m`).all(from, from, from);
  // Kho tồn: hàng không serial cùng mã gộp 1 dòng (giống trang Xem kho)
  const stock = db.prepare(`
    SELECT item_code, name, serial, COUNT(*) qty, condition, supplier, MIN(import_date) import_date, tech_price, retail_price,
           warranty_in_months, warranty_out_months, note
    FROM inventory_items WHERE status = 'in_stock'
    GROUP BY CASE WHEN COALESCE(serial, '') = '' AND item_code IS NOT NULL THEN 'c:' || item_code ELSE 'i:' || id END
    ORDER BY MAX(id) DESC`).all();
  const sold = db.prepare(`SELECT * FROM inventory_items WHERE status = 'sold' ORDER BY COALESCE(sold_date, '') DESC, id DESC`).all();

  return [
    {
      title: 'Doanh thu', money: [6], date: [1], datetime: [0],
      rows: [['Ngày giờ', 'Ngày', 'Loại', 'Nội dung', 'Khách hàng', 'SĐT', 'Số tiền', 'Thanh toán', 'BH (tháng)', 'Nhân viên', 'Số phiếu'],
        ...rev.map(r => [vnTime(r.created_at), vnTime(r.created_at).slice(0, 10), fmt.REVENUE_TYPE[r.type] || r.type, r.content || '', r.customer_name || '',
          r.customer_phone ? "'" + r.customer_phone : '', r.amount, pay(r.payment_method), r.warranty_months ?? '', r.staff_name || '', r.order_code || ''])],
    },
    {
      title: 'Chi phí', money: [2], date: [0],
      rows: [['Ngày', 'Nội dung', 'Số tiền', 'Thanh toán', 'Nhân viên', 'Ghi chú'],
        ...exp.map(e => [dmy(e.expense_date), e.content || '', e.amount, pay(e.payment_method), e.staff_name || '', e.note || ''])],
    },
    {
      title: 'Tổng hợp tháng', money: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      rows: [['Tháng', 'Số GD', 'Tiền mặt', 'Chuyển khoản', 'Công nợ', 'Sửa chữa', 'Bán hàng', 'Tổng thu', 'Thu nợ', 'Tổng chi', 'Thu − Chi'],
        ...months.map(m => [m.m.split('-').reverse().join('/'), m.n, m.cash, m.transfer, m.debt, m.repair, m.sale, m.thu, m.paid, m.chi, m.thu - m.chi])],
    },
    {
      title: 'Kho tồn', money: [7, 8], date: [6],
      rows: [['Mã hàng', 'Tên hàng', 'Serial', 'SL', 'Tình trạng', 'NPP', 'Ngày nhập', 'Giá KT', 'Giá bán lẻ', 'BH nhập (tháng)', 'BH xuất (tháng)', 'Ghi chú'],
        ...stock.map(i => [i.item_code || '', i.name || '', i.serial ? "'" + i.serial : '', i.qty, i.condition || '', i.supplier || '', dmy(i.import_date),
          i.tech_price ?? '', i.retail_price ?? '', i.warranty_in_months ?? '', i.warranty_out_months ?? '', i.note || ''])],
    },
    {
      title: 'Kho đã bán', money: [6, 7], date: [3, 9],
      rows: [['Mã hàng', 'Tên hàng', 'Serial', 'Ngày bán', 'Khách hàng', 'SĐT', 'Giá KT', 'Giá bán', 'NPP', 'Ngày nhập', 'BH xuất (tháng)', 'Ghi chú'],
        ...sold.map(i => [i.item_code || '', i.name || '', i.serial ? "'" + i.serial : '', dmy(i.sold_date), i.customer_name || '', i.customer_phone ? "'" + i.customer_phone : '',
          i.tech_price ?? '', i.retail_price ?? '', i.supplier || '', dmy(i.import_date), i.warranty_out_months ?? '', i.note || ''])],
    },
  ];
}

// ---------- ghi lên Google Sheet ----------
async function sync(reason = 'manual') {
  const c = cfg();
  if (!c.id) throw new Error('Chưa nhập link Google Sheet.');
  if (state.running) throw new Error('Đang đồng bộ, đợi chút.');
  state.running = true;
  const t0 = Date.now();
  try {
    const api = sheetsApi();
    const tabs = buildTabs(c.from);
    // 1. tạo trang tính còn thiếu
    const meta = await api.spreadsheets.get({ spreadsheetId: c.id, fields: 'properties.title,sheets.properties(sheetId,title)' });
    const have = new Map(meta.data.sheets.map(s => [s.properties.title, s.properties.sheetId]));
    const missing = tabs.filter(t => !have.has(t.title));
    if (missing.length) {
      const r = await api.spreadsheets.batchUpdate({ spreadsheetId: c.id, requestBody: {
        requests: missing.map(t => ({ addSheet: { properties: { title: t.title, gridProperties: { frozenRowCount: 1 } } } })),
      } });
      r.data.replies.forEach((rep, i) => have.set(missing[i].title, rep.addSheet.properties.sheetId));
    }
    // Trang tính trống mặc định của file mới ("Trang tính1" / "Sheet1") -> xóa cho gọn (chỉ khi hoàn toàn trống)
    const defaults = meta.data.sheets.map(s => s.properties).filter(p => /^(Sheet|Trang tính)\s?\d+$/i.test(p.title));
    if (defaults.length && have.size - defaults.length >= tabs.length) {
      const v = await api.spreadsheets.values.batchGet({ spreadsheetId: c.id, ranges: defaults.map(p => `'${p.title}'`) });
      const empty = defaults.filter((p, i) => !(v.data.valueRanges[i].values || []).length);
      if (empty.length) await api.spreadsheets.batchUpdate({ spreadsheetId: c.id, requestBody: { requests: empty.map(p => ({ deleteSheet: { sheetId: p.sheetId } })) } }).catch(() => {});
    }
    // 2. xóa dữ liệu cũ + ghi mới (2 lần gọi cho tất cả trang tính)
    await api.spreadsheets.values.batchClear({ spreadsheetId: c.id, requestBody: { ranges: tabs.map(t => `'${t.title}'`) } });
    await api.spreadsheets.values.batchUpdate({ spreadsheetId: c.id, requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: tabs.map(t => ({ range: `'${t.title}'!A1`, values: t.rows })),
    } });
    // 3. định dạng: dòng tiêu đề đậm + cố định, cột tiền "1.500.000", tự giãn cột
    const requests = [];
    for (const t of tabs) {
      const sheetId = have.get(t.title);
      const n = t.rows.length, cols = t.rows[0].length;
      requests.push(
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: cols },
          cell: { userEnteredFormat: { textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, backgroundColor: { red: 0.15, green: 0.39, blue: 0.92 } } },
          fields: 'userEnteredFormat(textFormat,backgroundColor)' } },
      );
      const fmtCol = (col, pattern, type) => requests.push({ repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: Math.max(2, n), startColumnIndex: col, endColumnIndex: col + 1 },
        cell: { userEnteredFormat: { numberFormat: { type, pattern } } }, fields: 'userEnteredFormat.numberFormat' } });
      (t.date || []).forEach(col => fmtCol(col, 'dd/mm/yyyy', 'DATE'));
      (t.datetime || []).forEach(col => fmtCol(col, 'dd/mm/yyyy hh:mm', 'DATE_TIME'));
      for (const col of t.money || []) {
        requests.push({ repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: Math.max(2, n), startColumnIndex: col, endColumnIndex: col + 1 },
          cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' } } }, fields: 'userEnteredFormat.numberFormat' } });
      }
      requests.push({ autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: cols } } });
    }
    await api.spreadsheets.batchUpdate({ spreadsheetId: c.id, requestBody: { requests } });

    const counts = Object.fromEntries(tabs.map(t => [t.title, t.rows.length - 1]));
    const res = { at: new Date().toISOString(), ok: true, reason, seconds: Math.round((Date.now() - t0) / 100) / 10, counts, title: meta.data.properties.title };
    settings.set({ gsheet_last: JSON.stringify(res) });
    console.log(`[gsheet] đồng bộ xong (${reason}) ${res.seconds}s:`, Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', '));
    return res;
  } catch (e) {
    const msg = friendly(e);
    settings.set({ gsheet_last: JSON.stringify({ at: new Date().toISOString(), ok: false, reason, error: msg }) });
    console.error('[gsheet] lỗi đồng bộ:', msg);
    throw new Error(msg);
  } finally { state.running = false; }
}

function friendly(e) {
  const m = String((e && (e.errors && e.errors[0] && e.errors[0].message)) || (e && e.message) || e);
  const code = e && (e.code || e.status);
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(m)) return 'Google Sheets API chưa bật cho dự án — bật tại console.cloud.google.com (APIs → Google Sheets API → Enable).';
  if (code === 403 || /permission|caller does not have/i.test(m)) return `Tài khoản dịch vụ chưa có quyền sửa file — chia sẻ file Sheet (quyền Người chỉnh sửa) cho ${serviceEmail()}.`;
  if (code === 404 || /not found/i.test(m)) return 'Không tìm thấy file Google Sheet — kiểm tra lại link.';
  return m.slice(0, 300);
}

// ---------- hẹn giờ hằng ngày (giờ VN) ----------
function parseAt(at) {
  const hm = String(at || '').match(/^(\d{1,2}):(\d{2})$/) || [null, '0', '00'];
  return [Math.min(23, Number(hm[1])), Math.min(59, Number(hm[2]))];
}
function nextDaily(hh, mm, now = Date.now()) {
  const vn = new Date(now + 7 * 3600e3);
  let t = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), hh, mm) - 7 * 3600e3;
  if (t <= now + 1000) t += 24 * 3600e3;
  return t;
}
const run = reason => sync(reason).catch(() => {});
function arm() {
  clearTimeout(timer); clearTimeout(catchUp);
  const [hh, mm] = parseAt(cfg().at);
  state.at = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const loop = () => {
    const t = nextDaily(hh, mm);
    state.nextRunAt = new Date(t).toISOString();
    timer = setTimeout(() => run('auto').finally(loop), t - Date.now());
    timer.unref();
  };
  loop();
  // đã qua giờ đồng bộ hôm nay mà chưa chạy (máy chủ tắt / restart đúng lúc) -> chạy bù sau 2 phút
  const last = lastRun();
  const today = fmt.todayYmd();
  const vn = new Date(Date.now() + 7 * 3600e3);
  const lastDay = last && last.ok ? fmt.todayYmd(new Date(last.at)) : '';
  if (cfg().id && lastDay !== today && vn.getUTCHours() * 60 + vn.getUTCMinutes() >= hh * 60 + mm) { catchUp = setTimeout(() => run('auto'), 120e3); catchUp.unref(); }
}
function schedule() {
  if (env.BACKUP_DISABLED === 'true' || env.GSHEET_SYNC_DISABLED === 'true') return; // server chạy thử: không ghi lên Sheet
  if (!serviceEmail()) { console.log('[gsheet] chưa có tài khoản dịch vụ Google — tắt đồng bộ Google Sheet'); return; }
  state.enabled = true;
  arm();
  if (cfg().id) console.log(`[gsheet] tự đồng bộ Google Sheet mỗi ngày lúc ${state.at} (giờ VN)`);
}

function setConfig({ url, from, at }) {
  const out = {};
  if (url !== undefined) {
    const id = String(url).trim() ? parseId(url) : '';
    if (id === null) throw Object.assign(new Error('Link Google Sheet không hợp lệ (dạng https://docs.google.com/spreadsheets/d/...).'), { status: 400 });
    out.gsheet_id = id;
  }
  if (from !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw Object.assign(new Error('Ngày bắt đầu không hợp lệ.'), { status: 400 });
    out.gsheet_from = from;
  }
  if (at !== undefined) {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) throw Object.assign(new Error('Giờ đồng bộ dạng HH:MM.'), { status: 400 });
    out.gsheet_sync_at = at.padStart(5, '0');
  }
  settings.set(out);
  if (state.enabled) arm();
  return status();
}

function status() {
  const c = cfg();
  return {
    enabled: state.enabled, running: state.running, at: c.at, from: c.from, nextRunAt: state.enabled && c.id ? state.nextRunAt : null,
    id: c.id, url: c.id ? `https://docs.google.com/spreadsheets/d/${c.id}/edit` : '', email: serviceEmail(), last: lastRun(),
  };
}

module.exports = { sync, schedule, status, setConfig, parseId, buildTabs };

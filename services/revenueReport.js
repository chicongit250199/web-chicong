'use strict';
// Báo cáo doanh thu qua email (Gmail SMTP):
//  - Hằng ngày lúc REPORT_DAILY_AT (mặc định 20:00 giờ VN): doanh thu trong ngày
//  - Ngày cuối tháng, cùng giờ: thêm báo cáo cả tháng
// Chủ nhật cửa hàng nghỉ: không gửi; thứ 2 gộp luôn giao dịch Chủ nhật (nếu có). Ngày cuối tháng rơi vào
// Chủ nhật -> báo cáo tháng gửi 20h thứ 2 (ngày 1 tháng sau).
// Đã gửi thì ghi dấu vào bảng settings để khởi động lại không gửi trùng; server khởi động sau giờ gửi
// mà hôm nay chưa gửi -> gửi bù.
const nodemailer = require('nodemailer');
const db = require('../db');
const fmt = require('./format');
const settings = require('./settings');
const taskAlerts = require('./taskAlerts'); // đăng ký hàm SQL work_days

const env = process.env;
const cfg = () => ({
  host: env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(env.SMTP_PORT, 10) || 465,
  user: (env.SMTP_USER || '').trim(),
  pass: (env.SMTP_PASS || '').replace(/\s+/g, ''), // mật khẩu ứng dụng Gmail hay chép kèm dấu cách
  to: (env.REPORT_EMAIL_TO || '').trim(),
  at: (settings.get('report_daily_at') || env.REPORT_DAILY_AT || '20:00').trim(), // đổi ở trang Hệ thống
});

const VN_DAY = `date(created_at, '+7 hours')`;
const SUMS = `COUNT(*) AS count, COALESCE(SUM(amount),0) AS total,
  COALESCE(SUM(CASE WHEN payment_method='cash' THEN amount END),0) AS cash,
  COALESCE(SUM(CASE WHEN payment_method='transfer' THEN amount END),0) AS transfer,
  COALESCE(SUM(CASE WHEN payment_method='debt' THEN amount END),0) AS debt,
  COALESCE(SUM(CASE WHEN type='repair' THEN amount END),0) AS repair,
  COALESCE(SUM(CASE WHEN type='sale' THEN amount END),0) AS sale`;

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const prevMonth = ym => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const isLastDayOfMonth = ymd => addDays(ymd, 1).slice(8) === '01';
const weekday = ymd => new Date(ymd + 'T00:00:00Z').getUTCDay(); // 0 = Chủ nhật
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const WD_LONG = ['Chủ nhật', 'thứ 2', 'thứ 3', 'thứ 4', 'thứ 5', 'thứ 6', 'thứ 7'];

// ---------- HTML ----------
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => esc(fmt.money(n || 0));
const TD = 'padding:6px 8px;border-bottom:1px solid #e2e8f0;';
const TDR = TD + 'text-align:right;white-space:nowrap;';
const TH = 'padding:6px 8px;background:#f1f5f9;text-align:left;font-size:12px;color:#475569;';

function diff(cur, prev, label) {
  if (!prev) return cur ? `<span style="color:#64748b">${label}: chưa có doanh thu</span>` : '';
  const pct = Math.round(((cur - prev) / prev) * 100);
  const color = pct >= 0 ? '#047857' : '#b91c1c';
  return `<span style="color:${color}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span> <span style="color:#64748b">so với ${label} (${money(prev)})</span>`;
}

// Thu nợ trong khoảng ngày (tiền khách trả nợ — không cộng vào doanh thu)
const debtPaid = (from, to) => db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM debt_payments WHERE date(created_at, '+7 hours') BETWEEN ? AND ?`).get(from, to).t;

function summaryTable(s, expense, paid = 0) {
  const rows = [
    ['Tổng doanh thu', `<b style="font-size:18px">${money(s.total)}</b>`],
    ['Số giao dịch', esc(s.count)],
    ['Sửa chữa', money(s.repair)],
    ['Bán hàng', money(s.sale)],
    ['Tiền mặt', money(s.cash)],
    ['Chuyển khoản', money(s.transfer)],
    ...(s.debt ? [['Bán công nợ (chưa thu)', money(s.debt)]] : []),
    ...(paid ? [['Thu nợ', money(paid)]] : []),
    ['Chi phí', money(expense)],
    ['Doanh thu − chi phí', `<b>${money(s.total - expense)}</b>`],
  ];
  return `<table style="border-collapse:collapse;width:100%;max-width:480px;font-size:14px">${rows.map(([k, v]) => `<tr><td style="${TD}color:#475569">${k}</td><td style="${TDR}">${v}</td></tr>`).join('')}</table>`;
}

function layout(title, body) {
  return `<!doctype html><html><body style="margin:0;padding:16px;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<div style="max-width:720px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px">
<h2 style="margin:0 0 4px;font-size:20px">${esc(title)}</h2>
${body}
<p style="margin-top:24px;font-size:12px;color:#94a3b8">Gửi tự động từ web nội bộ Chí Công Computer lúc ${esc(fmt.datetime(new Date().toISOString()))}.</p>
</div></body></html>`;
}

// ---------- Tiến độ công việc (task sửa máy) trong khoảng ngày from..to ----------
const DAYQ = col => `date(${col}, '+7 hours') BETWEEN @from AND @to`;
const TASK_COLS = `t.ticket_code, t.device_model, t.customer_name, t.status, t.final_price, t.estimated_price,
  COALESCE(NULLIF(t.technician_name,''), u.full_name) AS tech, t.created_at, t.updated_at`;
const TASK_FROM = 'FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to';

function taskTable(rows, cols) {
  if (!rows.length) return '';
  const head = cols.map(c => `<th style="${TH}${c.right ? 'text-align:right' : ''}">${c.h}</th>`).join('');
  const body = rows.map(r => `<tr>${cols.map(c => `<td style="${c.right ? TDR : TD}">${c.v(r)}</td>`).join('')}</tr>`).join('');
  return `<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:6px"><tr>${head}</tr>${body}</table>`;
}
const cTicket = { h: 'Phiếu', v: r => `<span style="white-space:nowrap">${esc(r.ticket_code)}</span>` };
const cDevice = { h: 'Máy / khách', v: r => `${esc(r.device_model)}${r.customer_name ? `<br><span style="color:#64748b">${esc(r.customer_name)}</span>` : ''}` };
const cTech = { h: 'Kỹ thuật', v: r => esc(r.tech || '—') };
const cStatus = { h: 'Trạng thái', v: r => esc(fmt.status(r.status).label) };

function taskSection(from, to) {
  const p = { from, to };
  const received = db.prepare(`SELECT ${TASK_COLS} ${TASK_FROM} WHERE ${DAYQ('t.created_at')} ORDER BY t.created_at`).all(p);
  const finished = db.prepare(`SELECT ${TASK_COLS} ${TASK_FROM} WHERE t.status IN ('done','unrepairable') AND ${DAYQ('t.updated_at')} ORDER BY t.updated_at`).all(p);
  const returned = db.prepare(`SELECT ${TASK_COLS} ${TASK_FROM} WHERE t.status = 'completed' AND ${DAYQ('t.completed_at')} ORDER BY t.completed_at`).all(p);
  const open = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) c FROM tasks WHERE status <> 'completed' GROUP BY status`).all().map(r => [r.status, r.c]));
  const byTech = db.prepare(`SELECT COALESCE(NULLIF(t.technician_name,''), u.full_name, '(chưa ai nhận)') AS tech,
      SUM(t.status = 'pending') pending, SUM(t.status = 'processing') processing,
      SUM(t.status IN ('done','unrepairable') AND ${DAYQ('t.updated_at')}) finished
    ${TASK_FROM} WHERE t.status IN ('pending','processing') OR (t.status IN ('done','unrepairable') AND ${DAYQ('t.updated_at')})
    GROUP BY tech ORDER BY processing DESC, pending DESC`).all(p);
  const overdue = db.prepare(`SELECT ${TASK_COLS}, ${taskAlerts.AGE} AS age ${TASK_FROM} WHERE ${taskAlerts.OVERDUE_WHERE} ORDER BY age DESC LIMIT 30`).all();

  const stat = (label, n, color) => `<td style="padding:8px;text-align:center;border:1px solid #e2e8f0"><div style="font-size:20px;font-weight:bold;color:${color}">${esc(n || 0)}</div><div style="font-size:12px;color:#64748b">${label}</div></td>`;
  const waitingReturn = (open.done || 0) + (open.unrepairable || 0);
  const ageText = d => (d >= 1 ? `${Math.floor(d)} ngày` : `${Math.floor(d * 24)} giờ`);

  return `<h3 style="margin:28px 0 0;font-size:16px;border-top:2px solid #e2e8f0;padding-top:16px">Tiến độ công việc</h3>
<table style="border-collapse:collapse;width:100%;margin-top:8px"><tr>
${stat('Nhận mới', received.length, '#1d4ed8')}${stat('Sửa xong / không sửa được', finished.length, '#047857')}${stat('Đã trả khách', returned.length, '#6d28d9')}
</tr></table>
<p style="margin:10px 0 0;font-size:13px;color:#475569">Đang tồn: <b>${esc(open.pending || 0)}</b> chờ xử lý · <b>${esc(open.processing || 0)}</b> đang sửa · <b>${esc(waitingReturn)}</b> chờ trả máy${overdue.length ? ` · <b style="color:#b91c1c">${esc(overdue.length)} quá hạn</b>` : ''}</p>
${byTech.length ? `<h4 style="margin:16px 0 0;font-size:14px">Theo kỹ thuật viên</h4>
<table style="border-collapse:collapse;width:100%;max-width:520px;font-size:13px;margin-top:6px"><tr><th style="${TH}">Kỹ thuật</th><th style="${TH}text-align:right">Chờ xử lý</th><th style="${TH}text-align:right">Đang sửa</th><th style="${TH}text-align:right">Xong hôm nay</th></tr>
${byTech.map(r => `<tr><td style="${TD}">${esc(r.tech)}</td><td style="${TDR}">${esc(r.pending)}</td><td style="${TDR}">${esc(r.processing)}</td><td style="${TDR}">${esc(r.finished)}</td></tr>`).join('')}</table>` : ''}
${overdue.length ? `<h4 style="margin:16px 0 0;font-size:14px;color:#b91c1c">Máy quá hạn (không tính Chủ nhật)</h4>
${taskTable(overdue, [cTicket, cDevice, cTech, cStatus, { h: 'Đã chờ', right: true, v: r => `<b style="color:#b91c1c">${esc(ageText(r.age))}</b>` }])}` : ''}
${finished.length ? `<h4 style="margin:16px 0 0;font-size:14px">Sửa xong / không sửa được — chờ khách lấy</h4>
${taskTable(finished, [cTicket, cDevice, cTech, cStatus, { h: 'Giá', right: true, v: r => money(r.final_price ?? r.estimated_price) }])}` : ''}
${received.length ? `<h4 style="margin:16px 0 0;font-size:14px">Máy nhận mới</h4>
${taskTable(received, [cTicket, cDevice, cTech, cStatus])}` : ''}
${returned.length ? `<h4 style="margin:16px 0 0;font-size:14px">Đã trả khách</h4>
${taskTable(returned, [cTicket, cDevice, cTech, { h: 'Thu', right: true, v: r => money(r.final_price) }])}` : ''}`;
}

// ---------- Báo cáo ngày ----------
// Thứ 2: gộp thêm Chủ nhật nếu hôm đó có giao dịch / chi phí
function dailyReport(day = fmt.todayYmd()) {
  let from = day;
  if (weekday(day) === 1) {
    const sun = addDays(day, -1);
    const n = db.prepare(`SELECT (SELECT COUNT(*) FROM revenues WHERE ${VN_DAY} = ?) + (SELECT COUNT(*) FROM expenses WHERE expense_date = ?) n`).get(sun, sun).n;
    if (n) from = sun;
  }
  // so với ngày làm việc trước đó (bỏ Chủ nhật)
  let prevDay = addDays(from, -1);
  if (weekday(prevDay) === 0) prevDay = addDays(prevDay, -1);

  const s = db.prepare(`SELECT ${SUMS} FROM revenues WHERE ${VN_DAY} BETWEEN ? AND ?`).get(from, day);
  const prev = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM revenues WHERE ${VN_DAY} = ?`).get(prevDay).t;
  const month = db.prepare(`SELECT COALESCE(SUM(amount),0) t, COUNT(*) c FROM revenues WHERE ${VN_DAY} BETWEEN ? AND ?`).get(day.slice(0, 7) + '-01', day);
  const expense = db.prepare('SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE expense_date BETWEEN ? AND ?').get(from, day).t;
  const list = db.prepare(`SELECT * FROM revenues WHERE ${VN_DAY} BETWEEN ? AND ? ORDER BY created_at`).all(from, day);
  const multi = from !== day;
  const hhmm = iso => new Date(Date.parse(iso) + 7 * 3600e3).toISOString().slice(11, 16); // giờ VN
  const when = r => (multi ? `${WD[weekday(fmt.todayYmd(new Date(r.created_at)))]} ` : '') + hhmm(r.created_at);

  const items = list.length ? `<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:8px">
<tr><th style="${TH}">Giờ</th><th style="${TH}">Loại</th><th style="${TH}">Nội dung / khách</th><th style="${TH}">Thanh toán</th><th style="${TH}text-align:right">Số tiền</th></tr>
${list.map(r => `<tr><td style="${TD}white-space:nowrap">${esc(when(r))}</td><td style="${TD}">${esc(fmt.REVENUE_TYPE[r.type])}</td>
<td style="${TD}">${esc(r.content)}${r.customer_name ? `<br><span style="color:#64748b">${esc(r.customer_name)}${r.customer_phone ? ' · ' + esc(r.customer_phone) : ''}</span>` : ''}${r.staff_name ? `<br><span style="color:#94a3b8;font-size:12px">NV: ${esc(r.staff_name)}</span>` : ''}</td>
<td style="${TD}">${esc(fmt.payment(r.payment_method))}</td><td style="${TDR}">${money(r.amount)}</td></tr>`).join('')}
</table>` : '<p style="color:#64748b">Chưa có giao dịch nào.</p>';

  const title = multi ? `Doanh thu Chủ nhật ${fmt.date(from).slice(0, 5)} + thứ 2 ${fmt.date(day)}` : `Doanh thu ngày ${fmt.date(day)}`;
  const body = `<p style="margin:0 0 16px;font-size:13px">${diff(s.total, prev, `${WD_LONG[weekday(prevDay)]} ${fmt.date(prevDay).slice(0, 5)}`)}</p>
${multi ? '<p style="margin:0 0 12px;font-size:13px;color:#b45309">Chủ nhật có phát sinh giao dịch nên gộp chung vào báo cáo thứ 2.</p>' : ''}
${summaryTable(s, expense, debtPaid(from, day))}
<p style="margin:12px 0 0;font-size:13px;color:#475569">Lũy kế tháng ${esc(day.slice(5, 7))}/${esc(day.slice(0, 4))} đến hôm nay: <b>${money(month.t)}</b> · ${esc(month.c)} giao dịch</p>
<h3 style="margin:20px 0 0;font-size:15px">Chi tiết giao dịch</h3>${items}
${taskSection(from, day)}
<p style="font-size:12px;color:#94a3b8">Số liệu tính đến lúc gửi; giao dịch sau giờ này sẽ nằm trong báo cáo tháng / trang Thống kê.</p>`;
  return { subject: `[Chí Công] ${title}: ${fmt.money(s.total)}`, html: layout(title, body), total: s.total };
}

// ---------- Báo cáo tháng ----------
function monthlyReport(ym = fmt.todayYmd().slice(0, 7)) {
  const from = ym + '-01', to = addDays(addDays(from, 32).slice(0, 8) + '01', -1);
  const s = db.prepare(`SELECT ${SUMS} FROM revenues WHERE ${VN_DAY} BETWEEN ? AND ?`).get(from, to);
  const pm = prevMonth(ym);
  const prev = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM revenues WHERE strftime('%Y-%m', created_at, '+7 hours') = ?`).get(pm).t;
  const expense = db.prepare('SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE expense_date BETWEEN ? AND ?').get(from, to).t;
  const days = new Map(db.prepare(`SELECT ${VN_DAY} AS d, ${SUMS} FROM revenues WHERE ${VN_DAY} BETWEEN ? AND ? GROUP BY d`).all(from, to).map(r => [r.d, r]));
  const expDays = new Map(db.prepare('SELECT expense_date d, SUM(amount) t FROM expenses WHERE expense_date BETWEEN ? AND ? GROUP BY d').all(from, to).map(r => [r.d, r.t]));
  const staff = db.prepare(`SELECT COALESCE(NULLIF(staff_name,''),'(không rõ)') name, COUNT(*) c, SUM(amount) t FROM revenues
    WHERE ${VN_DAY} BETWEEN ? AND ? GROUP BY name ORDER BY t DESC`).all(from, to);

  let dayRows = '';
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = days.get(d) || { count: 0, total: 0, repair: 0, sale: 0 };
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    dayRows += `<tr style="${wd === 0 ? 'background:#f8fafc;color:#94a3b8' : ''}"><td style="${TD}white-space:nowrap">${WD[wd]} ${esc(fmt.date(d).slice(0, 5))}</td><td style="${TDR}">${esc(r.count)}</td>
<td style="${TDR}">${money(r.repair)}</td><td style="${TDR}">${money(r.sale)}</td><td style="${TDR}">${money(expDays.get(d) || 0)}</td><td style="${TDR}"><b>${money(r.total)}</b></td></tr>`;
  }
  const best = [...days.values()].sort((a, b) => b.total - a.total)[0];
  const activeDays = [...days.values()].filter(r => r.count).length;

  const title = `Doanh thu tháng ${ym.slice(5, 7)}/${ym.slice(0, 4)}`;
  const body = `<p style="margin:0 0 16px;font-size:13px">${diff(s.total, prev, `tháng ${pm.slice(5, 7)}/${pm.slice(0, 4)}`)}</p>
${summaryTable(s, expense, debtPaid(from, to))}
<p style="margin:12px 0 0;font-size:13px;color:#475569">${esc(activeDays)} ngày có doanh thu · trung bình ${money(activeDays ? Math.round(s.total / activeDays) : 0)}/ngày${best ? ` · cao nhất ${esc(fmt.date(best.d))}: ${money(best.total)}` : ''}</p>
${staff.length ? `<h3 style="margin:20px 0 0;font-size:15px">Theo nhân viên</h3>
<table style="border-collapse:collapse;width:100%;max-width:480px;font-size:13px;margin-top:8px"><tr><th style="${TH}">Nhân viên</th><th style="${TH}text-align:right">Giao dịch</th><th style="${TH}text-align:right">Doanh thu</th></tr>
${staff.map(r => `<tr><td style="${TD}">${esc(r.name)}</td><td style="${TDR}">${esc(r.c)}</td><td style="${TDR}">${money(r.t)}</td></tr>`).join('')}</table>` : ''}
<h3 style="margin:20px 0 0;font-size:15px">Theo ngày</h3>
<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:8px">
<tr><th style="${TH}">Ngày</th><th style="${TH}text-align:right">GD</th><th style="${TH}text-align:right">Sửa chữa</th><th style="${TH}text-align:right">Bán hàng</th><th style="${TH}text-align:right">Chi phí</th><th style="${TH}text-align:right">Tổng</th></tr>
${dayRows}</table>`;
  return { subject: `[Chí Công] ${title}: ${fmt.money(s.total)}`, html: layout(title, body), total: s.total };
}

// ---------- Gửi ----------
let transporter = null;
function configured() { const c = cfg(); return Boolean(c.user && c.pass && c.to); }
async function send({ subject, html }) {
  const c = cfg();
  if (!configured()) throw new Error('Chưa cấu hình SMTP_USER / SMTP_PASS / REPORT_EMAIL_TO trong .env');
  transporter ||= nodemailer.createTransport({ host: c.host, port: c.port, secure: c.port === 465, auth: { user: c.user, pass: c.pass } });
  await transporter.sendMail({ from: `"Chí Công Computer" <${c.user}>`, to: c.to, subject, html });
}

const state = { enabled: false, at: null, nextRunAt: null, last: null, lastError: null };

async function sendDaily(day, { mark = true } = {}) {
  await send(dailyReport(day));
  if (mark) settings.set({ report_daily_last: day });
}
async function sendMonthly(ym, { mark = true } = {}) {
  await send(monthlyReport(ym));
  if (mark) settings.set({ report_monthly_last: ym });
}

// Tháng cần gửi báo cáo hôm nay (nếu có): ngày cuối tháng (trừ Chủ nhật), hoặc thứ 2 ngày 1 khi cuối tháng trước là Chủ nhật
function monthDue(day) {
  if (weekday(day) === 0) return null;
  if (isLastDayOfMonth(day)) return day.slice(0, 7);
  if (weekday(day) === 1 && day.slice(8) === '01') return addDays(day, -1).slice(0, 7);
  return null;
}

// Gửi những báo cáo của hôm nay còn thiếu (Chủ nhật nghỉ, không gửi)
async function runDue() {
  const day = fmt.todayYmd();
  if (weekday(day) === 0) return;
  const done = [];
  try {
    if (settings.get('report_daily_last') !== day) { await sendDaily(day); done.push('ngày'); }
    const ym = monthDue(day);
    if (ym && settings.get('report_monthly_last') !== ym) { await sendMonthly(ym); done.push(`tháng ${ym}`); }
    if (done.length) {
      state.last = { at: new Date().toISOString(), what: done.join(' + ') };
      console.log(`[report] đã gửi báo cáo doanh thu ${done.join(' + ')} ${day} tới ${cfg().to}`);
    }
    state.lastError = null;
  } catch (e) {
    state.lastError = { at: new Date().toISOString(), message: e.message };
    console.error('[report] lỗi gửi mail:', e.message);
  }
}

function nextDaily(hh, mm, now = Date.now()) {
  const vn = new Date(now + 7 * 3600e3);
  let t = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), hh, mm) - 7 * 3600e3;
  if (t <= now + 1000) t += 24 * 3600e3;
  return t;
}

let timer = null, catchUp = null;
function parseAt(at) {
  const hm = String(at || '').match(/^(\d{1,2}):(\d{2})$/) || [null, '20', '00'];
  return [Math.min(23, Number(hm[1])), Math.min(59, Number(hm[2]))];
}
// Đặt (lại) hẹn giờ theo giờ gửi hiện tại. Đã qua giờ gửi mà hôm nay chưa gửi -> gửi bù sau 1 phút
function arm() {
  clearTimeout(timer); clearTimeout(catchUp);
  const [hh, mm] = parseAt(cfg().at);
  state.at = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const loop = () => {
    const t = nextDaily(hh, mm);
    let n = t; // bỏ qua Chủ nhật khi hiển thị lần gửi kế tiếp
    if (weekday(fmt.todayYmd(new Date(n))) === 0) n += 24 * 3600e3;
    state.nextRunAt = new Date(n).toISOString();
    timer = setTimeout(() => runDue().finally(loop), t - Date.now());
    timer.unref();
  };
  loop();
  const vn = new Date(Date.now() + 7 * 3600e3);
  if (vn.getUTCHours() * 60 + vn.getUTCMinutes() >= hh * 60 + mm) { catchUp = setTimeout(runDue, 60e3); catchUp.unref(); }
}

function schedule() {
  if (env.REPORT_EMAIL_DISABLED === 'true' || env.BACKUP_DISABLED === 'true') return; // server chạy thử: không gửi
  if (!configured()) { console.log('[report] chưa cấu hình SMTP — tắt báo cáo doanh thu qua mail'); return; }
  state.enabled = true;
  arm();
  console.log(`[report] gửi báo cáo doanh thu mỗi ngày lúc ${state.at} (giờ VN) tới ${cfg().to}`);
}

// Quản lý đổi giờ gửi (HH:MM giờ VN) -> lưu settings, hẹn giờ lại ngay
function setTime(at) {
  const m = String(at || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw Object.assign(new Error('Giờ không hợp lệ (HH:MM)'), { status: 400 });
  const v = `${m[1].padStart(2, '0')}:${m[2]}`;
  settings.set({ report_daily_at: v });
  if (state.enabled) arm(); else state.at = v;
  console.log(`[report] đổi giờ gửi báo cáo thành ${v}`);
  return status();
}

function status() {
  const c = cfg();
  return { ...state, at: state.at || cfg().at, configured: configured(), to: c.to, user: c.user, dailyLast: settings.get('report_daily_last') || null, monthlyLast: settings.get('report_monthly_last') || null };
}

module.exports = { monthDue, dailyReport, monthlyReport, sendDaily, sendMonthly, runDue, schedule, status, setTime };

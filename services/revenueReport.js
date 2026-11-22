'use strict';
// Báo cáo doanh thu qua email (Gmail SMTP):
//  - Hằng ngày lúc REPORT_DAILY_AT (mặc định 20:00 giờ VN): doanh thu trong ngày
//  - Ngày cuối tháng, cùng giờ: thêm báo cáo cả tháng
// Đã gửi thì ghi dấu vào bảng settings để khởi động lại không gửi trùng; server khởi động sau giờ gửi
// mà hôm nay chưa gửi -> gửi bù.
const nodemailer = require('nodemailer');
const db = require('../db');
const fmt = require('./format');
const settings = require('./settings');

const env = process.env;
const cfg = () => ({
  host: env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(env.SMTP_PORT, 10) || 465,
  user: (env.SMTP_USER || '').trim(),
  pass: (env.SMTP_PASS || '').replace(/\s+/g, ''), // mật khẩu ứng dụng Gmail hay chép kèm dấu cách
  to: (env.REPORT_EMAIL_TO || '').trim(),
  at: (env.REPORT_DAILY_AT || '20:00').trim(),
});

const VN_DAY = `date(created_at, '+7 hours')`;
const SUMS = `COUNT(*) AS count, COALESCE(SUM(amount),0) AS total,
  COALESCE(SUM(CASE WHEN payment_method='cash' THEN amount END),0) AS cash,
  COALESCE(SUM(CASE WHEN payment_method='transfer' THEN amount END),0) AS transfer,
  COALESCE(SUM(CASE WHEN type='repair' THEN amount END),0) AS repair,
  COALESCE(SUM(CASE WHEN type='sale' THEN amount END),0) AS sale`;

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const prevMonth = ym => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const isLastDayOfMonth = ymd => addDays(ymd, 1).slice(8) === '01';

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

function summaryTable(s, expense) {
  const rows = [
    ['Tổng doanh thu', `<b style="font-size:18px">${money(s.total)}</b>`],
    ['Số giao dịch', esc(s.count)],
    ['Sửa chữa', money(s.repair)],
    ['Bán hàng', money(s.sale)],
    ['Tiền mặt', money(s.cash)],
    ['Chuyển khoản', money(s.transfer)],
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

// ---------- Báo cáo ngày ----------
function dailyReport(day = fmt.todayYmd()) {
  const s = db.prepare(`SELECT ${SUMS} FROM revenues WHERE ${VN_DAY} = ?`).get(day);
  const yesterday = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM revenues WHERE ${VN_DAY} = ?`).get(addDays(day, -1)).t;
  const month = db.prepare(`SELECT COALESCE(SUM(amount),0) t, COUNT(*) c FROM revenues WHERE ${VN_DAY} BETWEEN ? AND ?`).get(day.slice(0, 7) + '-01', day);
  const expense = db.prepare('SELECT COALESCE(SUM(amount),0) t FROM expenses WHERE expense_date = ?').get(day).t;
  const list = db.prepare(`SELECT * FROM revenues WHERE ${VN_DAY} = ? ORDER BY created_at`).all(day);

  const items = list.length ? `<table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:8px">
<tr><th style="${TH}">Giờ</th><th style="${TH}">Loại</th><th style="${TH}">Nội dung / khách</th><th style="${TH}">Thanh toán</th><th style="${TH}text-align:right">Số tiền</th></tr>
${list.map(r => `<tr><td style="${TD}white-space:nowrap">${esc(fmt.datetime(r.created_at).slice(-5))}</td><td style="${TD}">${esc(fmt.REVENUE_TYPE[r.type])}</td>
<td style="${TD}">${esc(r.content)}${r.customer_name ? `<br><span style="color:#64748b">${esc(r.customer_name)}${r.customer_phone ? ' · ' + esc(r.customer_phone) : ''}</span>` : ''}${r.staff_name ? `<br><span style="color:#94a3b8;font-size:12px">NV: ${esc(r.staff_name)}</span>` : ''}</td>
<td style="${TD}">${esc(fmt.payment(r.payment_method))}</td><td style="${TDR}">${money(r.amount)}</td></tr>`).join('')}
</table>` : '<p style="color:#64748b">Hôm nay chưa có giao dịch nào.</p>';

  const title = `Doanh thu ngày ${fmt.date(day)}`;
  const body = `<p style="margin:0 0 16px;font-size:13px">${diff(s.total, yesterday, 'hôm qua')}</p>
${summaryTable(s, expense)}
<p style="margin:12px 0 0;font-size:13px;color:#475569">Lũy kế tháng ${esc(day.slice(5, 7))}/${esc(day.slice(0, 4))} đến hôm nay: <b>${money(month.t)}</b> · ${esc(month.c)} giao dịch</p>
<h3 style="margin:20px 0 0;font-size:15px">Chi tiết giao dịch</h3>${items}
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

  const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
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
${summaryTable(s, expense)}
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

// Gửi những báo cáo của hôm nay còn thiếu
async function runDue() {
  const day = fmt.todayYmd();
  const done = [];
  try {
    if (settings.get('report_daily_last') !== day) { await sendDaily(day); done.push('ngày'); }
    if (isLastDayOfMonth(day) && settings.get('report_monthly_last') !== day.slice(0, 7)) { await sendMonthly(day.slice(0, 7)); done.push('tháng'); }
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

function schedule() {
  if (env.REPORT_EMAIL_DISABLED === 'true' || env.BACKUP_DISABLED === 'true') return; // server chạy thử: không gửi
  if (!configured()) { console.log('[report] chưa cấu hình SMTP — tắt báo cáo doanh thu qua mail'); return; }
  const hm = cfg().at.match(/^(\d{1,2}):(\d{2})$/) || [null, '20', '00'];
  const hh = Math.min(23, Number(hm[1])), mm = Math.min(59, Number(hm[2]));
  state.enabled = true;
  state.at = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const loop = () => {
    const t = nextDaily(hh, mm);
    state.nextRunAt = new Date(t).toISOString();
    setTimeout(() => runDue().finally(loop), t - Date.now()).unref();
  };
  loop();
  // Khởi động lại sau giờ gửi mà hôm nay chưa gửi -> gửi bù sau 1 phút
  const vn = new Date(Date.now() + 7 * 3600e3);
  if (vn.getUTCHours() * 60 + vn.getUTCMinutes() >= hh * 60 + mm) setTimeout(runDue, 60e3).unref();
  console.log(`[report] gửi báo cáo doanh thu mỗi ngày lúc ${state.at} (giờ VN) tới ${cfg().to}`);
}

function status() {
  const c = cfg();
  return { ...state, configured: configured(), to: c.to, user: c.user, dailyLast: settings.get('report_daily_last') || null, monthlyLast: settings.get('report_monthly_last') || null };
}

module.exports = { dailyReport, monthlyReport, sendDaily, sendMonthly, runDue, schedule, status };

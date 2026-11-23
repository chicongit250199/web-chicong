'use strict';
const config = require('../config');

const vnd = new Intl.NumberFormat('vi-VN');
const dtf = new Intl.DateTimeFormat('vi-VN', {
  timeZone: config.timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
const df = new Intl.DateTimeFormat('vi-VN', { timeZone: config.timezone, day: '2-digit', month: '2-digit', year: 'numeric' });
const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });

// Đường nhanh (gọi hàng trăm lần mỗi trang): Intl.format chậm hơn ~10 lần so với tự ghép chuỗi.
// Giờ VN cố định UTC+7 (không đổi giờ mùa hè); múi giờ khác thì dùng Intl như cũ.
const VN_TZ = config.timezone === 'Asia/Ho_Chi_Minh';
const p2 = n => (n < 10 ? '0' : '') + n;
function fastDatetime(s) {
  const d = new Date(s);
  const t = d.getTime();
  if (!VN_TZ || Number.isNaN(t)) return dtf.format(d);
  const v = new Date(t + 7 * 3600e3);
  return `${p2(v.getUTCHours())}:${p2(v.getUTCMinutes())} ${p2(v.getUTCDate())}/${p2(v.getUTCMonth() + 1)}/${v.getUTCFullYear()}`;
}
// Số nguyên -> '1.500.000' (số lẻ thập phân dùng Intl)
function fastNum(n) {
  n = Number(n);
  if (!Number.isSafeInteger(n)) return vnd.format(n);
  const neg = n < 0;
  let s = String(neg ? -n : n);
  for (let i = s.length - 3; i > 0; i -= 3) s = s.slice(0, i) + '.' + s.slice(i);
  return neg ? '-' + s : s;
}

const TASK_STATUS = {
  pending: { label: 'Chờ xử lý', cls: 'badge-blue' },
  processing: { label: 'Đang sửa', cls: 'badge-amber' },
  done: { label: 'Sửa xong', cls: 'badge-green' },
  unrepairable: { label: 'Không sửa được', cls: 'badge-red' },
  completed: { label: 'Đã trả máy', cls: 'badge-gray' },
};
const PAYMENT = { cash: 'Tiền mặt', transfer: 'Chuyển khoản' };
const REVENUE_TYPE = { repair: 'Sửa chữa', sale: 'Bán hàng' };

// 'YYYY-MM-DD' (ngày thuần, không giờ) -> dd/mm/yyyy, không lệch múi giờ
function plainDate(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : df.format(new Date(s));
}

module.exports = {
  TASK_STATUS, PAYMENT, REVENUE_TYPE,
  money: n => (n == null || n === '' ? '' : fastNum(n) + ' ₫'),
  num: n => (n == null || n === '' ? '' : fastNum(n)),
  datetime: s => (s ? fastDatetime(s) : ''),
  // ISO UTC -> 'HH:MM' giờ Việt Nam
  time: s => (s ? new Date(new Date(s).getTime() + 7 * 3600e3).toISOString().slice(11, 16) : ''),
  date: plainDate,
  dateShort: s => { const d = plainDate(s); return d ? d.slice(0, 6) + d.slice(8) : ''; }, // dd/mm/yy
  // 'YYYY-MM-DD' theo giờ Việt Nam
  todayYmd: (d = new Date()) => ymd.format(d),
  // '1.500.000' / '1,500,000 đ' -> 1500000
  parseMoney: v => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Math.round(v);
    const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  },
  status: s => TASK_STATUS[s] || { label: s, cls: 'badge-gray' },
  payment: p => PAYMENT[p] || p || '',
};

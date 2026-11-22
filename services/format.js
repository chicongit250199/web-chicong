'use strict';
const config = require('../config');

const vnd = new Intl.NumberFormat('vi-VN');
const dtf = new Intl.DateTimeFormat('vi-VN', {
  timeZone: config.timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
const df = new Intl.DateTimeFormat('vi-VN', { timeZone: config.timezone, day: '2-digit', month: '2-digit', year: 'numeric' });
const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });

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
  money: n => (n == null || n === '' ? '' : vnd.format(Number(n)) + ' ₫'),
  num: n => (n == null || n === '' ? '' : vnd.format(Number(n))),
  datetime: s => (s ? dtf.format(new Date(s)) : ''),
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

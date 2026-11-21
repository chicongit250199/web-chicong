'use strict';
const config = require('../config');

const vnd = new Intl.NumberFormat('vi-VN');
const dtf = new Intl.DateTimeFormat('vi-VN', {
  timeZone: config.timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
const df = new Intl.DateTimeFormat('vi-VN', { timeZone: config.timezone, day: '2-digit', month: '2-digit', year: 'numeric' });
const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });

module.exports = {
  money: n => (n == null || n === '' ? '' : vnd.format(Number(n)) + ' ₫'),
  datetime: s => (s ? dtf.format(new Date(s)) : ''),
  date: s => (s ? df.format(new Date(s)) : ''),
  // 'YYYY-MM-DD' theo giờ Việt Nam
  todayYmd: (d = new Date()) => ymd.format(d),
  // '1.500.000' / '1,500,000 đ' -> 1500000
  parseMoney: v => {
    if (v == null || v === '') return null;
    const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  },
};

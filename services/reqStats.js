'use strict';
// Đếm request của web (rất nhẹ: chỉ tăng vài con số trong RAM mỗi request).
// Tổng cộng dồn + số hôm nay lưu vào bảng settings mỗi phút (giữ qua các lần restart).
const settings = require('./settings');

const STATIC = /^\/(css|js|img|vendor|uploads|fonts|favicon)/;
const vnDay = (t = Date.now()) => new Date(t + 7 * 3600e3).toISOString().slice(0, 10);

let saved = {};
try { saved = JSON.parse(settings.get('req_stats') || '{}'); } catch { saved = {}; }
const st = {
  since: saved.since || new Date().toISOString(), // bắt đầu đếm
  total: saved.total || 0,
  day: saved.day || vnDay(),
  today: saved.day === vnDay() ? saved.today || 0 : 0,
  boot: 0, staticBoot: 0, errors: 0, // từ lần khởi động này
  pageMs: 0, pageN: 0,               // thời gian phản hồi trang / API (không tính file tĩnh, SSE)
  minutes: new Array(60).fill(0), minuteAt: Math.floor(Date.now() / 60000),
};

function rollMinute(now) {
  const m = Math.floor(now / 60000);
  const gap = Math.min(60, m - st.minuteAt);
  for (let i = 0; i < gap; i++) { st.minutes.shift(); st.minutes.push(0); }
  st.minuteAt = m;
}

function middleware(req, res, next) {
  const now = Date.now();
  const day = vnDay(now);
  if (day !== st.day) { st.day = day; st.today = 0; }
  st.total++; st.today++; st.boot++;
  rollMinute(now);
  st.minutes[59]++;
  const isStatic = STATIC.test(req.path);
  if (isStatic) { st.staticBoot++; return next(); }
  if (/\/events$/.test(req.path)) return next(); // luồng SSE mở lâu, không tính thời gian
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    if (res.statusCode >= 500) st.errors++;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    st.pageMs += ms; st.pageN++;
    if (ms > 2000) console.log(`[slow] ${req.method} ${req.originalUrl.slice(0, 120)} ${Math.round(ms)} ms (${res.statusCode})`);
  });
  next();
}

function save() {
  settings.set({ req_stats: JSON.stringify({ since: st.since, total: st.total, day: st.day, today: st.today }) });
}
setInterval(save, 60000).unref();
process.once('SIGINT', save); process.once('SIGTERM', save);

function stats() {
  rollMinute(Date.now());
  const last5 = st.minutes.slice(-5).reduce((a, b) => a + b, 0);
  return {
    since: st.since, total: st.total, today: st.today, boot: st.boot, staticBoot: st.staticBoot, errors: st.errors,
    lastMinute: st.minutes[59] + 0, perMin5: Math.round(last5 / 5 * 10) / 10, perHour: st.minutes.reduce((a, b) => a + b, 0),
    avgMs: st.pageN ? Math.round(st.pageMs / st.pageN * 10) / 10 : null,
    minutes: st.minutes.slice(),
  };
}

module.exports = { middleware, stats };

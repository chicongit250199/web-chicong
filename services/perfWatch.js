'use strict';
// Theo dõi độ trễ (để tìm nguyên nhân "thi thoảng chậm hơn 10 giây"):
//  - Luồng Node bị chặn: đo bằng monitorEventLoopDelay, đứng > 500 ms thì ghi log
//  - Trình duyệt gửi về chi tiết thời gian các trang / lệnh tải chậm (POST /perf-beacon), ghi log [perf]
// Xem: grep "\[perf\]\|\[lag\]\|\[slow\]" logs/out-0.log
const { monitorEventLoopDelay } = require('perf_hooks');
const express = require('express');

const LAG_MS = 500;
function start() {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  setInterval(() => {
    const max = h.max / 1e6;
    if (max > LAG_MS) console.log(`[lag] luồng xử lý bị đứng ${Math.round(max)} ms`);
    h.reset();
  }, 1000).unref();
}

// Nhận số đo từ trình duyệt (không cần đăng nhập / CSRF: chỉ ghi log, giới hạn kích thước, chỉ trong LAN)
const num = v => (Number.isFinite(+v) ? Math.round(+v) : null);
const router = express.Router();
router.post('/perf-beacon', express.text({ type: '*/*', limit: '2kb' }), (req, res) => {
  let d = {};
  try { d = JSON.parse(req.body || '{}'); } catch { return res.status(204).end(); }
  const f = ['total', 'stall', 'dns', 'connect', 'queue', 'ttfb', 'download', 'dom'].map(k => `${k}=${num(d[k])}`).join(' ');
  const ip = (req.ip || '').replace(/^::ffff:/, '');
  console.log(`[perf] ${ip} ${String(d.kind || 'page').slice(0, 10)} ${String(d.path || '').slice(0, 120)} ${f} host=${String(d.host || '').slice(0, 40)} nav=${String(d.nav || '').slice(0, 12)} ua=${String(d.ua || '').replace(/\s+/g, ' ').slice(0, 90)}`);
  res.status(204).end();
});

module.exports = { start, router };

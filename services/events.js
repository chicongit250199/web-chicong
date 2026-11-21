'use strict';
// Thông báo real-time cho Manager qua Server-Sent Events + lưu vào bảng notifications
const db = require('../db');

const clients = new Set();
const ins = db.prepare('INSERT INTO notifications (type, message, link, actor_name) VALUES (?, ?, ?, ?)');
const getOne = db.prepare('SELECT * FROM notifications WHERE id = ?');

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Express handler: GET /manager/events
function stream(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

// notify('sale', 'Nhân viên A bán RAM 8GB — 500.000 ₫', '/staff/search?q=...', 'Nhân viên A')
function notify(type, message, link, actor) {
  const { lastInsertRowid } = ins.run(type, message, link || null, actor || null);
  const n = getOne.get(lastInsertRowid);
  for (const c of clients) send(c, 'notification', n);
  return n;
}

module.exports = { stream, notify, clientCount: () => clients.size };

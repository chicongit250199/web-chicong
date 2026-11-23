'use strict';
// Thông báo real-time qua Server-Sent Events + lưu vào bảng notifications
// audience 'all': quản lý + nhân viên (việc cùng cấp: bán hàng, sửa chữa, nhập kho); 'manager': chỉ quản lý
const db = require('../db');

const clients = new Set();
const ins = db.prepare('INSERT INTO notifications (type, message, link, actor_name, audience) VALUES (?, ?, ?, ?, ?)');
// Loại thông báo nhân viên được xem (mặc định); loại khác muốn cho nhân viên thấy thì truyền audience = 'all'
const STAFF_TYPES = new Set(['task_new', 'task_processing', 'task_done', 'task_unrepairable', 'task_completed', 'task_redo', 'task_edited', 'sale']);
const getOne = db.prepare('SELECT * FROM notifications WHERE id = ?');

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Express handler: GET /manager/events, /staff/events
function stream(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const c = { res, manager: req.user && req.user.role === 'manager' };
  clients.add(c);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(c); });
}

// notify('sale', 'Nhân viên A bán RAM 8GB — 500.000 ₫', '/staff/search?q=...', 'Nhân viên A')
function notify(type, message, link, actor, audience) {
  const aud = audience || (STAFF_TYPES.has(type) ? 'all' : 'manager');
  const { lastInsertRowid } = ins.run(type, message, link || null, actor || null, aud);
  const n = getOne.get(lastInsertRowid);
  for (const c of clients) if (c.manager || aud === 'all') send(c.res, 'notification', n);
  return n;
}

module.exports = { stream, notify, clientCount: () => clients.size };

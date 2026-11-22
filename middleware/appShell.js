'use strict';
// Dữ liệu cho khung trang nội bộ: menu, số đếm trên badge, thông báo
const db = require('../db');
const menu = require('../services/menu');
const taskAlerts = require('../services/taskAlerts');

const q = {
  pending: db.prepare(`SELECT COUNT(*) c FROM tasks WHERE status = 'pending' AND assigned_to IS NULL`),
  assigned: db.prepare(`SELECT COUNT(*) c FROM tasks WHERE status = 'pending' AND assigned_to = ?`),
  processing: db.prepare(`SELECT COUNT(*) c FROM tasks WHERE status = 'processing' AND assigned_to = ?`),
  processingAll: db.prepare(`SELECT COUNT(*) c FROM tasks WHERE status = 'processing'`),
  ready: db.prepare(`SELECT COUNT(*) c FROM tasks WHERE status IN ('done','unrepairable')`),
  productsPending: db.prepare(`SELECT COUNT(*) c FROM products WHERE status = 'pending'`),
  notifications: db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 40'),
  unread: db.prepare('SELECT COUNT(*) c FROM notifications WHERE is_read = 0'),
  staffNotifs: db.prepare(`SELECT n.*, CASE WHEN n.id <= u.notif_seen_id THEN 1 ELSE 0 END AS is_read
    FROM notifications n, users u WHERE u.id = ? AND n.audience = 'all' ORDER BY n.id DESC LIMIT 40`),
  staffUnread: db.prepare(`SELECT COUNT(*) c FROM notifications WHERE audience = 'all'
    AND id > (SELECT notif_seen_id FROM users WHERE id = ?)`),
};

// Thông báo cho khung chuông: quản lý xem tất cả (đọc chung), nhân viên xem loại 'all' (đọc riêng từng người)
function notifData(u) {
  return u.role === 'manager'
    ? { items: q.notifications.all(), unread: q.unread.get().c }
    : { items: q.staffNotifs.all(u.id), unread: q.staffUnread.get(u.id).c };
}

function appShell(req, res, next) {
  const u = req.user;
  const isManager = u.role === 'manager';
  const badges = {
    pending: q.pending.get().c,
    assigned: q.assigned.get(u.id).c,
    processing: isManager ? q.processingAll.get().c : q.processing.get(u.id).c,
    ready: q.ready.get().c,
  };
  if (isManager) {
    badges.unassigned = badges.pending;
    badges.productsPending = q.productsPending.get().c;
  }
  const nd = notifData(u);
  res.locals.notifications = nd.items;
  res.locals.unreadCount = nd.unread;
  res.locals.notifBase = isManager ? '/manager' : '/staff';
  res.locals.isManager = isManager;
  res.locals.menuGroups = menu.groupsFor(isManager ? 'manager' : 'staff');
  res.locals.badges = badges;
  // Task quá lâu chưa thay đổi -> khung cảnh báo đầu trang + nhãn trên thẻ task
  res.locals.taskAlerts = taskAlerts.forUser(u);
  res.locals.alertOf = taskAlerts.level;
  res.locals.taskAlertDays = taskAlerts.thresholds();
  badges.overdue = res.locals.taskAlerts.length;
  res.locals.nav = '';
  next();
};

module.exports = appShell;
module.exports.notifData = notifData;

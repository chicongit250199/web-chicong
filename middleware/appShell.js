'use strict';
// Dữ liệu cho khung trang nội bộ: menu, số đếm trên badge, thông báo (manager)
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
};

module.exports = function appShell(req, res, next) {
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
    res.locals.notifications = q.notifications.all();
    res.locals.unreadCount = q.unread.get().c;
  }
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

'use strict';
const express = require('express');
const db = require('../../db');
const { notify } = require('../../services/events');

const router = express.Router();

router.get('/assign', (req, res) => {
  res.locals.nav = 'm-tasks'; // nằm trong mục Quản lý task
  const tasks = db.prepare(`SELECT t.*, u.full_name AS assigned_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to
                            WHERE t.status IN ('pending','processing') ORDER BY t.status, t.assigned_to IS NOT NULL, t.created_at`).all();
  const staff = db.prepare(`SELECT u.id, u.full_name, u.role,
      (SELECT COUNT(*) FROM tasks t WHERE t.assigned_to = u.id AND t.status = 'pending') AS pending,
      (SELECT COUNT(*) FROM tasks t WHERE t.assigned_to = u.id AND t.status = 'processing') AS processing
      FROM users u WHERE u.is_active = 1 ORDER BY u.role DESC, u.full_name`).all();
  res.render('manager/assign', { title: 'Phân task', tasks, staff });
});

router.post('/assign', (req, res) => {
  const taskId = Number(req.body.task_id);
  const userId = req.body.user_id ? Number(req.body.user_id) : null;
  const back = typeof req.body.back === 'string' && req.body.back.startsWith('/') && !req.body.back.startsWith('//') ? req.body.back : '/manager/assign';
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const staff = userId ? db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(userId) : null;
  if (!task || (userId && !staff)) { req.flash('error', 'Task hoặc nhân viên không hợp lệ.'); return res.redirect(back); }
  if (!['pending', 'processing'].includes(task.status)) { req.flash('error', 'Chỉ phân được task chưa xong.'); return res.redirect(back); }
  db.prepare('UPDATE tasks SET assigned_to = ?, technician_name = CASE WHEN status = ? THEN ? ELSE technician_name END, updated_at = ? WHERE id = ?')
    .run(userId, 'processing', staff ? staff.full_name : null, new Date().toISOString(), task.id);
  notify('task_processing', staff ? `${req.user.full_name} giao ${task.device_model} (${task.ticket_code}) cho ${staff.full_name}` : `${req.user.full_name} bỏ phân công ${task.ticket_code}`,
    `/staff/tasks/${task.id}`, req.user.full_name);
  req.flash('success', staff ? `Đã giao ${task.ticket_code} cho ${staff.full_name}.` : `Đã bỏ phân công ${task.ticket_code}.`);
  res.redirect(back);
});

module.exports = router;

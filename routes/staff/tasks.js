'use strict';
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const fmt = require('../../services/format');
const { nextTicketCode } = require('../../services/tickets');
const { notify } = require('../../services/events');
const taskAlerts = require('../../services/taskAlerts');

const router = express.Router();

const q = {
  get: db.prepare(`SELECT t.*, u.full_name AS assigned_name, r.full_name AS received_name FROM tasks t
                   LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN users r ON r.id = t.received_by WHERE t.id = ?`),
  histories: db.prepare('SELECT * FROM task_histories WHERE task_id = ? ORDER BY attempt_no DESC, id DESC'),
  insert: db.prepare(`INSERT INTO tasks (ticket_code, customer_name, customer_phone, device_model, specs, issue_desc, estimated_price,
                      expected_return_date, accessories, note, status, received_by)
                      VALUES (@ticket_code, @customer_name, @customer_phone, @device_model, @specs, @issue_desc, @estimated_price,
                      @expected_return_date, @accessories, @note, 'pending', @received_by)`),
  staff: db.prepare(`SELECT id, full_name FROM users WHERE is_active = 1 ORDER BY role DESC, full_name`),
  revenue: db.prepare(`SELECT * FROM revenues WHERE type = 'repair' AND ref_id = ? ORDER BY id DESC`),
};

const LIST_SQL = `SELECT t.*, u.full_name AS assigned_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to`;

// Danh sách theo "view" của menu
function listTasks(view, user, search) {
  const where = [];
  const params = {};
  const isManager = user.role === 'manager';
  switch (view) {
    case 'pending': where.push(`t.status = 'pending'`, `t.assigned_to IS NULL`); break;
    case 'assigned': where.push(`t.status = 'pending'`, isManager ? 't.assigned_to IS NOT NULL' : 't.assigned_to = @uid'); break;
    case 'processing': where.push(`t.status = 'processing'`); if (!isManager) where.push('t.assigned_to = @uid'); break;
    case 'ready': where.push(`t.status IN ('done','unrepairable')`); break;
    case 'completed': where.push(`t.status = 'completed'`); break;
    case 'overdue': where.push(taskAlerts.OVERDUE_WHERE); if (!isManager) where.push('(t.assigned_to IS NULL OR t.assigned_to = @uid)'); break;
    default: break;
  }
  if (search) {
    where.push(`(t.customer_phone LIKE @s OR t.device_model LIKE @s OR t.ticket_code LIKE @s OR t.customer_name LIKE @s)`);
    params.s = `%${search}%`;
  }
  params.uid = user.id;
  const order = view === 'completed' ? 't.completed_at DESC' : view === 'overdue' ? `${taskAlerts.AGE} DESC` : 't.created_at ASC';
  return db.prepare(`${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 200`).all(params);
}

const VIEW_TITLES = {
  pending: ['Task chưa làm', 'tasks-pending'], assigned: ['Task được giao', 'tasks-assigned'],
  processing: ['Task đang làm', 'tasks-processing'], ready: ['Chờ trả máy', 'return'], completed: ['Máy đã trả', 'completed'], overdue: ['Task quá hạn', 'tasks-overdue'],
  all: ['Tất cả Task', 'tasks-pending'],
};

function canWork(task, user) {
  return user.role === 'manager' || !task.assigned_to || task.assigned_to === user.id;
}
function back(req, res, id, type, msg) { req.flash(type, msg); res.redirect(`/staff/tasks/${id}`); }

// ---------- Tổng quan 2 cột ----------
router.get('/', (req, res) => {
  const u = req.user;
  const isManager = u.role === 'manager';
  const LIMIT = 40; // mỗi cột hiện tối đa 40 task, còn lại xem ở danh sách đầy đủ
  const newTasksAll = listTasks('pending', u);
  const newTasks = newTasksAll.slice(0, LIMIT);
  const mine = isManager
    ? db.prepare(`${LIST_SQL} WHERE t.status = 'processing' OR (t.status = 'pending' AND t.assigned_to IS NOT NULL) ORDER BY t.status DESC, t.created_at LIMIT ${LIMIT + 1}`).all()
    : db.prepare(`${LIST_SQL} WHERE t.assigned_to = ? AND t.status IN ('pending','processing') ORDER BY t.status DESC, t.created_at LIMIT ${LIMIT + 1}`).all(u.id);
  res.locals.nav = 'home';
  res.render('staff/dashboard', { title: 'Tổng quan', newTasks, newTotal: newTasksAll.length, mine: mine.slice(0, LIMIT), mineMore: mine.length > LIMIT });
});

// ---------- Nhận máy ----------
const createSchema = v.z.object({
  customer_name: v.text(120),
  customer_phone: v.phone(true),
  device_model: v.reqText('Nhập Model máy / linh kiện', 200),
  specs: v.text(1000),
  issue_desc: v.reqText('Nhập mô tả lỗi', 2000),
  estimated_price: v.money,
  expected_return_date: v.date,
  accessories: v.text(500),
  note: v.text(1000),
});

router.get('/tasks/new', (req, res) => {
  res.locals.nav = 'task-new';
  res.render('staff/task_new', { title: 'Nhận máy', values: {}, error: null, now: new Date().toISOString() });
});

router.post('/tasks', (req, res) => {
  const { data, error } = v.parse(createSchema, req.body);
  if (error) {
    res.locals.nav = 'task-new';
    return res.status(422).render('staff/task_new', { title: 'Nhận máy', values: req.body, error, now: new Date().toISOString() });
  }
  const task = db.transaction(() => {
    const ticket_code = nextTicketCode();
    const { lastInsertRowid } = q.insert.run({ ...data, ticket_code, received_by: req.user.id });
    return { id: lastInsertRowid, ticket_code };
  })();
  notify('task_new', `${req.user.full_name} nhận máy ${data.device_model} (${task.ticket_code}) — KH ${data.customer_name || data.customer_phone}`, `/staff/tasks/${task.id}`, req.user.full_name);
  req.flash('success', `Đã lưu phiếu ${task.ticket_code}.`);
  res.redirect(req.body.print ? `/staff/tasks/${task.id}/print` : '/staff/tasks/new');
});

// ---------- Danh sách ----------
router.get('/tasks', (req, res) => {
  const view = VIEW_TITLES[req.query.view] ? req.query.view : 'all';
  const search = String(req.query.q || '').trim();
  const [title, nav] = VIEW_TITLES[view];
  res.locals.nav = nav;
  res.render('staff/tasks', { title, view, search, tasks: listTasks(view, req.user, search) });
});

// ---------- Trả máy: tìm theo SĐT / Model trong các task done + unrepairable ----------
router.get('/return', (req, res) => {
  const search = String(req.query.q || '').trim();
  res.locals.nav = 'return';
  res.render('staff/tasks', { title: 'Trả máy', view: 'ready', search, tasks: listTasks('ready', req.user, search), returnMode: true });
});

// ---------- Chi tiết ----------
router.get('/tasks/:id', (req, res, next) => {
  const task = q.get.get(req.params.id);
  if (!task) return next();
  res.locals.nav = { pending: 'tasks-pending', processing: 'tasks-processing', done: 'return', unrepairable: 'return' }[task.status] || '';
  res.render('staff/task_detail', {
    title: task.ticket_code, task, histories: q.histories.all(task.id), staffList: q.staff.all(),
    revenues: q.revenue.all(task.id), canWork: canWork(task, req.user), canDelete: canDelete(task, req.user), warrantyOptions: v.WARRANTY_OPTIONS,
  });
});

router.get('/tasks/:id/print', (req, res, next) => {
  const task = q.get.get(req.params.id);
  if (!task) return next();
  res.render('staff/task_print', { title: task.ticket_code, task });
});

// ---------- Bấm "Xử lý": pending -> processing ----------
router.post('/tasks/:id/start', (req, res, next) => {
  const task = q.get.get(req.params.id);
  if (!task) return next();
  if (!canWork(task, req.user)) return back(req, res, task.id, 'error', `Task đã được giao cho ${task.assigned_name}.`);
  const r = db.prepare(`UPDATE tasks SET status = 'processing', assigned_to = COALESCE(assigned_to, ?), technician_name = ?, updated_at = ?
                        WHERE id = ? AND status = 'pending'`).run(req.user.id, req.user.full_name, new Date().toISOString(), task.id);
  if (!r.changes) return back(req, res, task.id, 'error', 'Task không còn ở trạng thái chờ xử lý.');
  notify('task_processing', `${req.user.full_name} bắt đầu sửa ${task.device_model} (${task.ticket_code})`, `/staff/tasks/${task.id}`, req.user.full_name);
  back(req, res, task.id, 'success', 'Đã nhận xử lý task.');
});

// ---------- "Xong": processing -> done ----------
const doneSchema = v.z.object({ repair_detail: v.text(2000), replaced_parts: v.text(1000), final_price: v.money });
router.post('/tasks/:id/done', (req, res, next) => {
  const task = q.get.get(req.params.id);
  if (!task) return next();
  if (!canWork(task, req.user)) return back(req, res, task.id, 'error', 'Bạn không phụ trách task này.');
  const { data, error } = v.parse(doneSchema, req.body);
  if (error) return back(req, res, task.id, 'error', error);
  const r = db.prepare(`UPDATE tasks SET status = 'done', repair_detail = ?, replaced_parts = ?, final_price = ?, technician_name = ?,
                        fail_reason = NULL, updated_at = ? WHERE id = ? AND status = 'processing'`)
    .run(data.repair_detail, data.replaced_parts, data.final_price ?? task.estimated_price ?? 0, req.user.full_name, new Date().toISOString(), task.id);
  if (!r.changes) return back(req, res, task.id, 'error', 'Task không ở trạng thái đang sửa.');
  notify('task_done', `${req.user.full_name} sửa xong ${task.device_model} (${task.ticket_code}) — ${fmt.money(data.final_price ?? task.estimated_price ?? 0)}`, `/staff/tasks/${task.id}`, req.user.full_name);
  back(req, res, task.id, 'success', 'Đã cập nhật: sửa xong. Task chuyển sang chờ trả máy.');
});

// ---------- "Không sửa được": processing -> unrepairable ----------
const failSchema = v.z.object({ fail_reason: v.reqText('Nhập lý do không sửa được', 1000), note: v.text(1000) });
router.post('/tasks/:id/fail', (req, res, next) => {
  const task = q.get.get(req.params.id);
  if (!task) return next();
  if (!canWork(task, req.user)) return back(req, res, task.id, 'error', 'Bạn không phụ trách task này.');
  const { data, error } = v.parse(failSchema, req.body);
  if (error) return back(req, res, task.id, 'error', error);
  const r = db.prepare(`UPDATE tasks SET status = 'unrepairable', fail_reason = ?, note = COALESCE(?, note), technician_name = ?, final_price = 0,
                        updated_at = ? WHERE id = ? AND status = 'processing'`)
    .run(data.fail_reason, data.note, req.user.full_name, new Date().toISOString(), task.id);
  if (!r.changes) return back(req, res, task.id, 'error', 'Task không ở trạng thái đang sửa.');
  notify('task_unrepairable', `${req.user.full_name}: không sửa được ${task.device_model} (${task.ticket_code}) — ${data.fail_reason}`, `/staff/tasks/${task.id}`, req.user.full_name);
  back(req, res, task.id, 'success', 'Đã cập nhật: không sửa được. Task chuyển sang chờ trả máy.');
});

// ---------- Trả máy "Hoàn thành": done/unrepairable -> completed + doanh thu ----------
const completeSchema = v.z.object({
  amount: v.money,
  payment_method: v.oneOf(['cash', 'transfer'], 'Chọn hình thức thanh toán'),
  warranty_months: v.intOneOf(v.WARRANTY_OPTIONS, 'Chọn thời hạn bảo hành'),
});
router.post('/tasks/:id/complete', (req, res, next) => {
  const task = q.get.get(req.params.id);
  if (!task) return next();
  const { data, error } = v.parse(completeSchema, req.body);
  if (error) return back(req, res, task.id, 'error', error);
  const amount = data.amount ?? (task.status === 'unrepairable' ? 0 : task.final_price ?? 0);
  const now = new Date().toISOString();
  const ok = db.transaction(() => {
    const r = db.prepare(`UPDATE tasks SET status = 'completed', final_price = ?, payment_method = ?, warranty_months = ?, completed_at = ?, updated_at = ?
                          WHERE id = ? AND status IN ('done','unrepairable')`).run(amount, data.payment_method, data.warranty_months, now, now, task.id);
    if (!r.changes) return false;
    const content = task.status === 'unrepairable'
      ? `Trả máy không sửa được: ${task.device_model} (${task.ticket_code})`
      : `Sửa chữa ${task.device_model} (${task.ticket_code})${task.repair_detail ? ': ' + task.repair_detail : ''}${task.replaced_parts ? ' — Thay: ' + task.replaced_parts : ''}`;
    db.prepare(`INSERT INTO revenues (type, ref_id, customer_name, customer_phone, content, amount, payment_method, warranty_months, staff_name, created_at)
                VALUES ('repair', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.id, task.customer_name, task.customer_phone, content.slice(0, 1000), amount, data.payment_method, data.warranty_months, req.user.full_name, now);
    return true;
  })();
  if (!ok) return back(req, res, task.id, 'error', 'Task không ở trạng thái chờ trả máy.');
  notify('task_completed', `${req.user.full_name} trả máy ${task.device_model} (${task.ticket_code}) — thu ${fmt.money(amount)} (${fmt.payment(data.payment_method)})`, `/staff/tasks/${task.id}`, req.user.full_name);
  back(req, res, task.id, 'success', `Đã trả máy, ghi nhận doanh thu ${fmt.money(amount)}.`);
});

// ---------- Trả máy "Sửa lại": lưu lịch sử lần sửa cũ -> processing ----------
router.post('/tasks/:id/redo', (req, res, next) => {
  const task = q.get.get(req.params.id);
  if (!task) return next();
  const note = String(req.body.note || '').trim().slice(0, 1000) || null;
  const ok = db.transaction(() => {
    const cur = db.prepare(`SELECT * FROM tasks WHERE id = ? AND status IN ('done','unrepairable')`).get(task.id);
    if (!cur) return false;
    const attempt = db.prepare('SELECT COALESCE(MAX(attempt_no), 0) + 1 n FROM task_histories WHERE task_id = ?').get(task.id).n;
    db.prepare(`INSERT INTO task_histories (task_id, attempt_no, status, technician_name, repair_detail, replaced_parts, price, fail_reason, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(cur.id, attempt, cur.status, cur.technician_name, cur.repair_detail, cur.replaced_parts, cur.final_price, cur.fail_reason,
        [cur.note, note && `Lý do sửa lại: ${note}`].filter(Boolean).join('\n') || null);
    db.prepare(`UPDATE tasks SET status = 'processing', repair_detail = NULL, replaced_parts = NULL, fail_reason = NULL,
                technician_name = ?, assigned_to = COALESCE(assigned_to, ?), updated_at = ? WHERE id = ?`)
      .run(req.user.full_name, req.user.id, new Date().toISOString(), cur.id);
    return true;
  })();
  if (!ok) return back(req, res, task.id, 'error', 'Task không ở trạng thái chờ trả máy.');
  notify('task_redo', `${req.user.full_name} mở lại sửa ${task.device_model} (${task.ticket_code})${note ? ' — ' + note : ''}`, `/staff/tasks/${task.id}`, req.user.full_name);
  back(req, res, task.id, 'success', 'Đã lưu lịch sử lần sửa trước và chuyển task về Đang sửa.');
});

// ---------- Xóa task ----------
// Nhân viên: chỉ task do mình nhận máy và chưa trả máy. Quản lý: mọi task; máy đã trả thì xóa kèm doanh thu.
function canDelete(task, user) {
  if (user.role === 'manager') return true;
  return task.received_by === user.id && task.status !== 'completed';
}

router.post('/tasks/:id/delete', (req, res, next) => {
  const task = q.get.get(req.params.id);
  if (!task) return next();
  if (!canDelete(task, req.user)) {
    return back(req, res, task.id, 'error', task.status === 'completed'
      ? 'Máy đã trả có doanh thu — chỉ Quản lý được xóa.' : 'Bạn chỉ được xóa task do chính mình nhận máy.');
  }
  const removed = db.transaction(() => {
    const rev = db.prepare(`DELETE FROM revenues WHERE type = 'repair' AND ref_id = ? RETURNING amount`).all(task.id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id); // task_histories xóa theo (ON DELETE CASCADE)
    return rev.reduce((s, r) => s + (r.amount || 0), 0);
  })();
  notify('task_deleted', `${req.user.full_name} xóa ${task.status === 'completed' ? 'máy đã trả' : 'task'} ${task.ticket_code} (${task.device_model})${removed ? ' — kèm doanh thu ' + fmt.money(removed) : ''}`,
    null, req.user.full_name);
  req.flash('success', `Đã xóa ${task.ticket_code}${removed ? `, trừ doanh thu ${fmt.money(removed)}` : ''}.`);
  const backTo = typeof req.body.back === 'string' && /^\/(?!\/)/.test(req.body.back) ? req.body.back : (task.status === 'completed' ? '/staff/tasks?view=completed' : '/staff');
  res.redirect(backTo);
});

module.exports = router;

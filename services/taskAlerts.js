'use strict';
// Cảnh báo task quá lâu không thay đổi (KHÔNG tính ngày Chủ nhật, theo giờ VN):
//  - Chưa làm (pending) quá PENDING_DAYS ngày kể từ lần thay đổi gần nhất
//  - Đang làm (processing) quá PROCESSING_DAYS ngày
const db = require('../db');

const PENDING_DAYS = Number(process.env.TASK_PENDING_ALERT_DAYS) || 3;
const PROCESSING_DAYS = Number(process.env.TASK_PROCESSING_ALERT_DAYS) || 1;

const DAY = 86400e3, WEEK = 7 * DAY, OFF = 7 * 3600e3; // giờ VN = UTC+7

// Số ngày (thập phân) từ sinceMs tới nowMs, trừ phần thời gian rơi vào Chủ nhật (giờ VN)
function workDays(sinceMs, nowMs = Date.now()) {
  if (!Number.isFinite(sinceMs) || nowMs <= sinceMs) return 0;
  let total = nowMs - sinceMs;
  let d = Math.floor((sinceMs + OFF) / DAY) * DAY - OFF; // 0h VN của ngày bắt đầu
  while (d < nowMs) {
    // nhảy nhanh cả tuần nằm trọn trong khoảng: mỗi tuần có đúng 1 Chủ nhật
    if (d >= sinceMs && d + WEEK <= nowMs) {
      const weeks = Math.floor((nowMs - d) / WEEK);
      total -= weeks * DAY;
      d += weeks * WEEK;
      continue;
    }
    if (new Date(d + OFF).getUTCDay() === 0) {
      total -= Math.max(0, Math.min(nowMs, d + DAY) - Math.max(sinceMs, d));
    }
    d += DAY;
  }
  return total / DAY;
}

// Hàm SQL work_days(thời_điểm_ISO): số ngày làm việc tính tới hiện tại (không cố định -> không deterministic)
db.function('work_days', s => (s ? workDays(Date.parse(s)) : 0));

// Biểu thức SQL dùng chung (t = bảng tasks)
const AGE = `work_days(COALESCE(t.updated_at, t.created_at))`;
const OVERDUE_WHERE = `((t.status = 'pending' AND ${AGE} > ${PENDING_DAYS}) OR (t.status = 'processing' AND ${AGE} > ${PROCESSING_DAYS}))`;

// Mức cảnh báo cho 1 task (dùng trong thẻ task)
function level(t, now = Date.now()) {
  const since = Date.parse(t.updated_at || t.created_at);
  if (!since) return null;
  const days = workDays(since, now);
  if (t.status === 'pending' && days > PENDING_DAYS) return { kind: 'pending', days, label: `Chờ ${fmtAge(days)} chưa xử lý` };
  if (t.status === 'processing' && days > PROCESSING_DAYS) return { kind: 'processing', days, label: `Đang sửa ${fmtAge(days)}` };
  return null;
}
function fmtAge(days) {
  return days >= 1 ? `${Math.floor(days)} ngày` : `${Math.floor(days * 24)} giờ`;
}

// Task quá hạn liên quan tới người dùng: nhân viên thấy task chưa ai nhận + task của mình; quản lý thấy tất cả
const qMine = db.prepare(`SELECT t.*, u.full_name AS assigned_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to
  WHERE ${OVERDUE_WHERE} AND (t.assigned_to IS NULL OR t.assigned_to = ?) ORDER BY ${AGE} DESC LIMIT 50`);
const qAll = db.prepare(`SELECT t.*, u.full_name AS assigned_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to
  WHERE ${OVERDUE_WHERE} ORDER BY ${AGE} DESC LIMIT 50`);

function forUser(user) {
  const rows = user.role === 'manager' ? qAll.all() : qMine.all(user.id);
  const now = Date.now();
  return rows.map(t => ({ ...t, alert: level(t, now) }));
}

module.exports = { PENDING_DAYS, PROCESSING_DAYS, OVERDUE_WHERE, AGE, level, forUser, workDays };

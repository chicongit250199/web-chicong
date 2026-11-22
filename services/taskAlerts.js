'use strict';
// Cảnh báo task quá lâu không thay đổi (KHÔNG tính ngày Chủ nhật, theo giờ VN):
//  - Chưa làm (pending) quá N ngày kể từ lần thay đổi gần nhất
//  - Đang làm (processing) quá M ngày
// N, M do quản lý chỉnh ở trang Hệ thống (bảng settings), mặc định lấy từ .env hoặc 3 / 1.
const db = require('../db');
const settings = require('./settings');

const DEF_PENDING = Number(process.env.TASK_PENDING_ALERT_DAYS) || 3;
const DEF_PROCESSING = Number(process.env.TASK_PROCESSING_ALERT_DAYS) || 1;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
function thresholds() {
  return { pending: num(settings.get('task_pending_alert_days'), DEF_PENDING), processing: num(settings.get('task_processing_alert_days'), DEF_PROCESSING) };
}
function setThresholds({ pending, processing }) {
  const ok = v => Number.isFinite(v) && v >= 0.5 && v <= 60;
  if (!ok(pending) || !ok(processing)) throw new Error('Số ngày phải từ 0,5 đến 60');
  settings.set({ task_pending_alert_days: pending, task_processing_alert_days: processing });
  return thresholds();
}

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

// Ngưỡng hiện tại theo trạng thái (đọc lúc chạy câu lệnh -> đổi cài đặt có hiệu lực ngay, không cần prepare lại)
db.function('task_alert_days', st => { const t = thresholds(); return st === 'pending' ? t.pending : st === 'processing' ? t.processing : null; });

// Biểu thức SQL dùng chung (t = bảng tasks)
const AGE = `work_days(COALESCE(t.updated_at, t.created_at))`;
const OVERDUE_WHERE = `(t.status IN ('pending','processing') AND ${AGE} > task_alert_days(t.status))`;

// Mức cảnh báo cho 1 task (dùng trong thẻ task)
function level(t, now = Date.now()) {
  const since = Date.parse(t.updated_at || t.created_at);
  if (!since) return null;
  const days = workDays(since, now);
  const th = thresholds();
  if (t.status === 'pending' && days > th.pending) return { kind: 'pending', days, label: `Chờ ${fmtAge(days)} chưa xử lý` };
  if (t.status === 'processing' && days > th.processing) return { kind: 'processing', days, label: `Đang sửa ${fmtAge(days)}` };
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

module.exports = { thresholds, setThresholds, OVERDUE_WHERE, AGE, level, forUser, workDays };

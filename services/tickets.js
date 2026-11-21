'use strict';
// Sinh mã phiếu CC-YYYYMMDD-XXX theo ngày giờ Việt Nam, an toàn trong transaction
const db = require('../db');
const fmt = require('./format');

const bump = db.prepare(`INSERT INTO ticket_counters (day, value) VALUES (?, 1)
  ON CONFLICT(day) DO UPDATE SET value = value + 1 RETURNING value`);

function nextTicketCode() {
  const day = fmt.todayYmd().replaceAll('-', '');
  const { value } = bump.get(day);
  return `CC-${day}-${String(value).padStart(3, '0')}`;
}

module.exports = { nextTicketCode };

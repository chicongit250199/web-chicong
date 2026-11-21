'use strict';
// Tiện ích kho hàng thường
const db = require('../db');

function stripVi(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

// "RAM Kingston Fury 16GB DDR4" -> "RAM-KINGSTON-FURY-16GB"
function makeItemCode(name) {
  return stripVi(name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-').slice(0, 32) || 'HANG';
}

// "12", "12T", "12 tháng", "1 năm", "1N" -> số tháng
function parseWarrantyMonths(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v);
  const s = stripVi(v).toLowerCase();
  const n = parseFloat(s.replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  if (/nam|year|\dn\b|\dy\b/.test(s)) return Math.round(n * 12);
  return Math.round(n);
}

// Ngày từ Excel: Date, số serial Excel, "dd/mm/yyyy", "yyyy-mm-dd" -> "YYYY-MM-DD"
function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

function parseMoney(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v);
  const s = String(v).toLowerCase().replace(/\s/g, '');
  const k = /k$/.test(s) ? 1000 : /tr|m$/.test(s) ? 1e6 : 1;
  const n = parseFloat(s.replace(/[^\d.,-]/g, '').replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * k) : null;
}

const qSerial = db.prepare('SELECT id, serial, name, status FROM inventory_items WHERE serial = ?');
function existingSerials(serials) {
  return serials.filter(Boolean).map(s => qSerial.get(s)).filter(Boolean);
}

// Ngày hết bảo hành = ngày bán + số tháng
function warrantyEnd(soldDate, months) {
  if (!soldDate || !months) return null;
  const d = new Date(soldDate.slice(0, 10) + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + Number(months));
  return d.toISOString().slice(0, 10);
}

module.exports = { stripVi, makeItemCode, parseWarrantyMonths, parseDate, parseMoney, existingSerials, warrantyEnd };

'use strict';
const bcrypt = require('bcryptjs');

const DEFAULT_SETTINGS = {
  company_name: 'Chí Công Computer',
  legal_name: 'Công ty TNHH Công nghệ Chí Công',
  tax_id: '0402341190',
  address: 'K18/9 Phan Tứ, P. Ngũ Hành Sơn, TP. Đà Nẵng',
  phone: '0763.02.86.86',
  featured_rows: '2',
  logo_url: '',
  banner_url: '',
  map_embed: '',
};

const DEFAULT_CATEGORIES = [
  ['Laptop', 'Laptop', 'Ноутбуки', '笔记本电脑', 'laptop'],
  ['PC - Máy bộ', 'Desktop PC', 'Компьютеры', '台式电脑', 'desktop'],
  ['Linh kiện', 'Components', 'Комплектующие', '电脑配件', 'cpu'],
  ['Dịch vụ sửa chữa', 'Repair services', 'Ремонт', '维修服务', 'wrench'],
];

module.exports = function seed(db) {
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    const ins = db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)');
    ins.run('admin', bcrypt.hashSync('123456', 10), 'Quản lý', 'manager');
    ins.run('staff1', bcrypt.hashSync('123456', 10), 'Nhân viên 1', 'staff');
    console.log('[db] seeded users admin / staff1 (mật khẩu 123456 — hãy đổi ngay)');
  }

  const catCount = db.prepare('SELECT COUNT(*) c FROM categories').get().c;
  if (catCount === 0) {
    const ins = db.prepare('INSERT INTO categories (name_vi, name_en, name_ru, name_zh, icon, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    DEFAULT_CATEGORIES.forEach((c, i) => ins.run(...c, i + 1));
  }
};

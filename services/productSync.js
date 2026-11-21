'use strict';
// Đưa hàng tồn kho lên trang chủ: gộp theo tên (chuẩn hóa), xếp danh mục tự động, gắn sản phẩm với kho để hiện còn/hết hàng
const db = require('../db');
const { similarity } = require('./vatReconcile');

// Khóa gộp: bỏ dấu, chữ thường, gộp khoảng trắng ("Màn Edra  EGM24F144S" = "Màn EDRA EGM24F144S")
const stockKey = s => db.vn(String(s || '')).replace(/\s+/g, ' ').trim();
db.function('stock_key', { deterministic: true }, s => (s == null ? null : stockKey(s)));

// Danh mục cần có (tạo nếu chưa có) — tên, tên EN/RU/ZH, icon, thứ tự
const CATS = {
  laptop: ['Laptop', 'Laptop', 'Ноутбуки', '笔记本电脑', 'laptop', 1],
  pc: ['PC - Máy bộ', 'Desktop PC', 'Компьютеры', '台式电脑', 'desktop', 2],
  monitor: ['Màn hình', 'Monitors', 'Мониторы', '显示器', 'monitor', 3],
  parts: ['Linh kiện', 'Components', 'Комплектующие', '电脑配件', 'cpu', 4],
  accessory: ['Phụ kiện', 'Accessories', 'Аксессуары', '电脑配件与外设', 'mouse', 5],
};

function classify(name) {
  const n = stockKey(name);
  if (/^(laptop|macbook|notebook)\b/.test(n) || /\b(thinkpad|latitude|vostro|inspiron|elitebook|probook|vivobook|zenbook|ideapad|macbook)\b/.test(n) && !/\b(ram|pin|sac|ban phim|man hinh laptop)\b/.test(n)) return 'laptop';
  if (/^(pc|may bo|bo may|case)\b/.test(n)) return 'pc';
  if (/^(man|man hinh|monitor)\b/.test(n)) return 'monitor';
  if (/\b(chuot|mouse|key|ban phim|keyboard|tai nghe|headphone|loa|webcam|card wifi|usb wifi|lot chuot|tay cam|balo|ba lo)\b/.test(n)) return 'accessory';
  return 'parts';
}

// Chuẩn hóa tình trạng: NEW / 2ND / LIKE NEW / Cũ...
function condLabel(c) {
  const n = db.vn(c || '').trim();
  if (!n) return null;
  if (/like ?new|99|98/.test(n)) return 'Like new';
  if (/^(new|moi)/.test(n)) return 'Mới';
  if (/2nd|cu|used|qua su dung/.test(n)) return 'Cũ';
  return c;
}

function ensureCategory(kind) {
  const [vi, en, ru, zh, icon, order] = CATS[kind];
  const found = db.prepare('SELECT id FROM categories WHERE vn(name_vi) = ? OR icon = ?').get(db.vn(vi), icon);
  if (found) return { id: found.id, created: false };
  const r = db.prepare('INSERT INTO categories (name_vi, name_en, name_ru, name_zh, icon, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)').run(vi, en, ru, zh, icon, order);
  return { id: r.lastInsertRowid, created: true };
}

// Số lượng còn trong kho theo khóa
function stockCounts() {
  return new Map(db.prepare(`SELECT stock_key(name) k, COUNT(*) c FROM inventory_items WHERE status = 'in_stock' GROUP BY k`).all().map(r => [r.k, r.c]));
}

function syncFromInventory(userId) {
  return db.transaction(() => {
    const groups = db.prepare(`SELECT stock_key(name) k, MIN(name) name, COUNT(*) qty, MAX(retail_price) price,
        MAX(condition) cond FROM inventory_items WHERE status = 'in_stock' GROUP BY k ORDER BY name`).all();
    const products = db.prepare('SELECT id, name_vi, stock_key FROM products').all();
    const res = { added: 0, linked: 0, skipped: 0, categories: [] };
    for (const g of groups) {
      if (products.some(p => p.stock_key === g.k)) { res.skipped++; continue; }
      // Sản phẩm đã đăng tay có tên rất giống -> gắn với kho, không tạo trùng
      const twin = products.find(p => !p.stock_key && similarity(p.name_vi, g.name) >= 0.8);
      if (twin) {
        db.prepare('UPDATE products SET stock_key = ?, condition = COALESCE(condition, ?) WHERE id = ?').run(g.k, condLabel(g.cond), twin.id);
        twin.stock_key = g.k; res.linked++; continue;
      }
      const kind = classify(g.name);
      const cat = ensureCategory(kind);
      if (cat.created) res.categories.push(CATS[kind][0]);
      db.prepare(`INSERT INTO products (category_id, name_vi, price, status, is_featured, created_by, stock_key, condition, source)
                  VALUES (?, ?, ?, 'approved', 0, ?, ?, ?, 'inventory')`).run(cat.id, g.name.replace(/\s+/g, ' ').trim(), g.price || null, userId || null, g.k, condLabel(g.cond));
      products.push({ name_vi: g.name, stock_key: g.k });
      res.added++;
    }
    // Sắp lại thứ tự danh mục cho dễ tìm
    if (res.categories.length) {
      const ORDER = { laptop: 1, desktop: 2, monitor: 3, cpu: 4, mouse: 5, wrench: 6 };
      for (const [icon, o] of Object.entries(ORDER)) db.prepare('UPDATE categories SET sort_order = ? WHERE icon = ?').run(o, icon);
    }
    return res;
  })();
}

module.exports = { stockKey, stockCounts, syncFromInventory, classify, condLabel };

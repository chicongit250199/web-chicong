'use strict';
// Ảnh sản phẩm: tối đa 5 ảnh, ảnh đầu = ảnh đại diện (products.image_url) dùng cho thẻ sản phẩm
const db = require('../db');
const { removeImage } = require('./upload');

const MAX = 5;
const list = id => db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort, id').all(id);

// Đồng bộ ảnh đại diện = ảnh đầu tiên
function syncCover(id) {
  const first = db.prepare('SELECT url FROM product_images WHERE product_id = ? ORDER BY sort, id LIMIT 1').get(id);
  db.prepare('UPDATE products SET image_url = ? WHERE id = ?').run(first ? first.url : null, id);
}

function add(id, url, sourceUrl) {
  const n = db.prepare('SELECT COUNT(*) c, COALESCE(MAX(sort), -1) m FROM product_images WHERE product_id = ?').get(id);
  if (n.c >= MAX) return false;
  db.prepare('INSERT INTO product_images (product_id, url, sort, source_url) VALUES (?, ?, ?, ?)').run(id, url, n.m + 1, sourceUrl || null);
  syncCover(id);
  return true;
}

function remove(imageId) {
  const img = db.prepare('SELECT * FROM product_images WHERE id = ?').get(imageId);
  if (!img) return null;
  db.prepare('DELETE FROM product_images WHERE id = ?').run(img.id);
  // chỉ xóa file nếu không còn sản phẩm nào dùng
  if (!db.prepare('SELECT 1 FROM product_images WHERE url = ?').get(img.url)) removeImage(img.url);
  syncCover(img.product_id);
  return img;
}

// Đưa 1 ảnh lên đầu (làm ảnh đại diện)
function makeCover(imageId) {
  const img = db.prepare('SELECT * FROM product_images WHERE id = ?').get(imageId);
  if (!img) return null;
  db.prepare('UPDATE product_images SET sort = sort + 1 WHERE product_id = ?').run(img.product_id);
  db.prepare('UPDATE product_images SET sort = 0 WHERE id = ?').run(img.id);
  syncCover(img.product_id);
  return img;
}

module.exports = { MAX, list, add, remove, makeCover, syncCover };

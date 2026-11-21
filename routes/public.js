'use strict';
const express = require('express');
const db = require('../db');
const { mapSrc } = require('../services/contact');
const { stockCounts } = require('../services/productSync');
const rich = require('../services/richText');

const router = express.Router();

// Số cột tối đa của lưới sản phẩm (xl). Mỗi danh mục lấy đủ rows × MAX_COLS sản phẩm,
// CSS ẩn bớt theo số cột thực tế của từng màn hình -> luôn đúng `featured_rows` hàng.
const MAX_COLS = 5;
const PAGE_SIZE = 24;

const q = {
  cats: db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order, id'),
  cat: db.prepare('SELECT * FROM categories WHERE id = ? AND is_active = 1'),
  // Ưu tiên sản phẩm nổi bật; nếu danh mục chưa chọn nổi bật thì lấy sản phẩm mới nhất
  featured: db.prepare(`SELECT * FROM products WHERE status = 'approved' AND category_id = ?
                        ORDER BY is_featured DESC, created_at DESC LIMIT ?`),
  countInCat: db.prepare(`SELECT COUNT(*) c FROM products WHERE status = 'approved' AND category_id = ?`),
  pageInCat: db.prepare(`SELECT * FROM products WHERE status = 'approved' AND category_id = ?
                         ORDER BY is_featured DESC, created_at DESC LIMIT ? OFFSET ?`),
  product: db.prepare(`SELECT * FROM products WHERE id = ? AND status = 'approved'`),
  related: db.prepare(`SELECT * FROM products WHERE status = 'approved' AND category_id = ? AND id <> ?
                       ORDER BY is_featured DESC, created_at DESC LIMIT 5`),
};

function common(res) {
  const s = res.locals.settings;
  // Số lượng còn trong kho của sản phẩm gắn kho (null = sản phẩm không gắn kho)
  const counts = stockCounts();
  res.locals.stockOf = p => (p && p.stock_key ? counts.get(p.stock_key) || 0 : null);
  res.locals.categories = q.cats.all();
  res.locals.mapSrc = mapSrc(s.map_embed, s.address);
}

router.get('/', (req, res) => {
  common(res);
  const rows = Math.min(Math.max(parseInt(res.locals.settings.featured_rows, 10) || 2, 1), 10);
  const sections = res.locals.categories.map(c => ({
    cat: c,
    products: q.featured.all(c.id, rows * MAX_COLS),
    total: q.countInCat.get(c.id).c,
  })).filter(s => s.products.length);
  res.render('public/index', { title: res.locals.settings.company_name, sections, rows });
});

router.get('/c/:id', (req, res, next) => {
  const cat = q.cat.get(req.params.id);
  if (!cat) return next();
  common(res);
  const total = q.countInCat.get(cat.id).c;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
  const products = q.pageInCat.all(cat.id, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  res.render('public/category', { title: res.locals.field(cat, 'name'), cat, products, page, pages, total });
});

router.get('/p/:id', (req, res, next) => {
  const p = q.product.get(req.params.id);
  if (!p) return next();
  common(res);
  const cat = p.category_id ? q.cat.get(p.category_id) : null;
  const related = p.category_id ? q.related.all(p.category_id, p.id) : [];
  res.render('public/product', {
    title: res.locals.field(p, 'name'), p, cat, related,
    descBlocks: rich.parseDescription(res.locals.field(p, 'desc')), specRows: rich.parseSpecs(p.specs_vi), titleCase: rich.titleCase,
  });
});

module.exports = router;

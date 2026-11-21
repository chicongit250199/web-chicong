'use strict';
const express = require('express');
const db = require('../../db');
const settings = require('../../services/settings');
const v = require('../../services/validate');
const { NAMES: ICON_NAMES } = require('../../services/icons');
const { imageUpload, saveImage, removeImage } = require('../../services/upload');

const router = express.Router();

router.get('/homepage', (req, res) => {
  res.locals.nav = 'm-homepage';
  const categories = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status = 'approved') AS n
                                 FROM categories c ORDER BY c.sort_order, c.id`).all();
  const products = db.prepare(`SELECT p.*, c.name_vi AS cat_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
                               WHERE p.status = 'approved' ORDER BY c.sort_order, p.is_featured DESC, p.created_at DESC`).all();
  res.render('manager/homepage', { title: 'Sửa trang chủ', categories, products, iconNames: ICON_NAMES, banners: getBanners() });
});

const settingsSchema = v.z.object({
  company_name: v.reqText('Nhập tên hiển thị', 100),
  legal_name: v.reqText('Nhập tên công ty', 200),
  tax_id: v.text(20),
  address: v.text(300),
  phone: v.text(30),
  featured_rows: v.z.coerce.number().int().min(1, 'Số hàng 1-10').max(10, 'Số hàng 1-10'),
  map_embed: v.text(3000),
  map_link: v.text(500),
});

router.post('/homepage/settings', imageUpload.fields([{ name: 'logo', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), async (req, res, next) => {
  try {
    const { data, error } = v.parse(settingsSchema, req.body);
    if (error) { req.flash('error', error); return res.redirect('/manager/homepage'); }
    const cur = settings.all();
    const patch = { ...data };
    for (const k of ['tax_id', 'address', 'phone', 'map_embed', 'map_link']) patch[k] = patch[k] || '';
    const files = req.files || {};
    if (files.logo) { patch.logo_url = await saveImage(files.logo[0], 'logo'); removeImage(cur.logo_url); }
    if (files.banner) { patch.banner_url = await saveImage(files.banner[0], 'banner'); removeImage(cur.banner_url); }
    if (req.body.remove_logo) { patch.logo_url = ''; removeImage(cur.logo_url); }
    if (req.body.remove_banner) { patch.banner_url = ''; removeImage(cur.banner_url); }
    settings.set(patch);
    req.flash('success', 'Đã lưu cài đặt trang chủ.');
    res.redirect('/manager/homepage');
  } catch (e) { next(e); }
});

// ---------- Banner trình chiếu (ngoài banner chính) ----------
function getBanners() {
  try { const a = JSON.parse(settings.get('banners') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveBanners(list) { settings.set({ banners: JSON.stringify(list) }); }

router.post('/banners', imageUpload.array('banners', 10), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) { req.flash('error', 'Chọn ít nhất 1 ảnh banner.'); return res.redirect('/manager/homepage#banners'); }
    const list = getBanners();
    for (const f of files) list.push(await saveImage(f, 'banner'));
    saveBanners(list);
    req.flash('success', `Đã thêm ${files.length} banner.`);
    res.redirect('/manager/homepage#banners');
  } catch (e) { next(e); }
});

router.post('/banners/:i/move', (req, res) => {
  const list = getBanners(); const i = Number(req.params.i); const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (list[i] && list[j]) { [list[i], list[j]] = [list[j], list[i]]; saveBanners(list); }
  res.redirect('/manager/homepage#banners');
});

router.post('/banners/:i/delete', (req, res) => {
  const list = getBanners(); const i = Number(req.params.i);
  if (list[i]) { removeImage(list[i]); list.splice(i, 1); saveBanners(list); req.flash('success', 'Đã xóa banner.'); }
  res.redirect('/manager/homepage#banners');
});

// ---------- Danh mục ----------
const catSchema = v.z.object({
  name_vi: v.reqText('Nhập tên danh mục', 100), name_en: v.text(100), name_ru: v.text(100), name_zh: v.text(100),
  icon: v.oneOf(ICON_NAMES, 'Icon không hợp lệ'),
  sort_order: v.z.coerce.number().int().min(0).max(999).default(0),
  is_active: v.z.preprocess(x => (x ? 1 : 0), v.z.number()),
});

router.post('/categories', (req, res) => {
  const { data, error } = v.parse(catSchema, { ...req.body, is_active: 1 });
  if (error) req.flash('error', error);
  else {
    db.prepare('INSERT INTO categories (name_vi, name_en, name_ru, name_zh, icon, sort_order, is_active) VALUES (@name_vi, @name_en, @name_ru, @name_zh, @icon, @sort_order, 1)').run(data);
    req.flash('success', `Đã thêm danh mục ${data.name_vi}.`);
  }
  res.redirect('/manager/homepage#categories');
});

router.post('/categories/:id', (req, res) => {
  const { data, error } = v.parse(catSchema, req.body);
  if (error) req.flash('error', error);
  else {
    db.prepare('UPDATE categories SET name_vi=@name_vi, name_en=@name_en, name_ru=@name_ru, name_zh=@name_zh, icon=@icon, sort_order=@sort_order, is_active=@is_active WHERE id=@id')
      .run({ ...data, id: Number(req.params.id) });
    req.flash('success', `Đã lưu danh mục ${data.name_vi}.`);
  }
  res.redirect('/manager/homepage#categories');
});

router.post('/categories/:id/delete', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) c FROM products WHERE category_id = ?').get(req.params.id).c;
  if (n) req.flash('error', `Danh mục còn ${n} sản phẩm — chuyển hoặc xóa sản phẩm trước, hoặc tắt hiển thị danh mục.`);
  else { db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id); req.flash('success', 'Đã xóa danh mục.'); }
  res.redirect('/manager/homepage#categories');
});

// ---------- Sản phẩm nổi bật ----------
router.post('/products/:id/feature', (req, res) => {
  db.prepare('UPDATE products SET is_featured = CASE is_featured WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').run(req.params.id);
  if (req.get('accept') && req.get('accept').includes('json')) {
    return res.json({ is_featured: db.prepare('SELECT is_featured FROM products WHERE id = ?').get(req.params.id)?.is_featured });
  }
  res.redirect('/manager/homepage#featured');
});

module.exports = router;

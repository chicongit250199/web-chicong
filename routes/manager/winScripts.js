'use strict';
// Hệ thống → Script Windows: quản lý các script PowerShell của link /shel
const express = require('express');
const ws = require('../../services/winScripts');
const shel = require('../shel');
const settings = require('../../services/settings');

const router = express.Router();

router.get('/system/scripts', (req, res) => {
  res.locals.nav = 'm-system';
  res.render('manager/win_scripts', { title: 'Script Windows', scripts: ['/js/win-scripts.js'], slug: shel.slug() });
});

// Bọc handler JSON: lỗi → 400 { error }
const j = (fn) => async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await fn(req)); }
  catch (e) { res.status(400).json({ error: e.message }); }
};
const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n) || n <= 0) throw new Error('Mã script không hợp lệ'); return n; };
const uid = (req) => req.user && req.user.id;
const listOut = () => ({ items: ws.list() });

router.get('/system/scripts.json', j(() => listOut()));
router.get('/system/scripts/:id/content', j(req => {
  const s = ws.get(id(req));
  if (!s) throw new Error('Không thấy script');
  return { item: { ...s, has_prev: s.prev_content != null, prev_content: undefined } };
}));
// Xem trước gist khi thêm mới: tên file, mô tả, nội dung
router.post('/system/scripts/gist', j(async req => ws.fetchGist(req.body.url, req.body.file)));
router.post('/system/scripts', j(req => { ws.create(req.body || {}, uid(req)); return listOut(); }));
// Đổi đuôi link bộ công cụ (VD chicongcomputer.local/shel → chicongcomputer.local/cc)
router.post('/system/scripts/slug', j(req => {
  const v = shel.checkSlug(req.body.slug);
  settings.set({ shel_path: v });
  return { slug: v };
}));
router.post('/system/scripts/sync-all', j(async req => ({ results: await ws.syncAll(uid(req)), ...listOut() })));
router.post('/system/scripts/:id', j(req => { ws.update(id(req), req.body || {}, uid(req)); return listOut(); }));
router.post('/system/scripts/:id/sync', j(async req => ({ result: await ws.sync(id(req), uid(req)), ...listOut() })));
router.post('/system/scripts/:id/undo', j(req => { ws.undo(id(req), uid(req)); return listOut(); }));
router.post('/system/scripts/:id/move', j(req => { ws.move(id(req), Number(req.body.dir)); return listOut(); }));
router.post('/system/scripts/:id/delete', j(req => { ws.remove(id(req)); return listOut(); }));

module.exports = router;

'use strict';
// Route liên kết Zalo dùng chung cho tài khoản (/manager/users/:id/zalo...) và đối tác (/staff/partners/:id/zalo...)
const zalo = require('./zaloBot');

module.exports = function zaloRoutes(router, prefix, kind, ...guards) {
  const zj = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await fn(Number(req.params.id), req)); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  };
  router.post(`${prefix}/:id/zalo/code`, ...guards, zj(id => zalo.createLinkCode(kind, id)));
  router.get(`${prefix}/:id/zalo`, ...guards, zj(id => zalo.linkInfo(kind, id)));
  router.post(`${prefix}/:id/zalo/enabled`, ...guards, zj((id, req) => zalo.setEnabled(kind, id, !!req.body.enabled)));
  router.post(`${prefix}/:id/zalo/unlink`, ...guards, zj(id => zalo.unlink(kind, id)));
  router.post(`${prefix}/:id/zalo/test`, ...guards, zj(async id => { await zalo.sendTest(kind, id); return { ok: true }; }));
};

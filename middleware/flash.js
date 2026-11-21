'use strict';
// Thông báo một lần sau redirect: req.flash('success', 'Đã lưu')
module.exports = function flash(req, res, next) {
  res.locals.flash = (req.session && req.session.flash) || [];
  if (req.session && req.session.flash) delete req.session.flash;
  req.flash = (type, message) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, message });
  };
  next();
};

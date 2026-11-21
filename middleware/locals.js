'use strict';
// Biến dùng chung cho mọi view: settings, ngôn ngữ, hàm format
const config = require('../config');
const settings = require('../services/settings');
const i18n = require('../services/i18n');
const fmt = require('../services/format');
const { icon } = require('../services/icons');
const contact = require('../services/contact');

module.exports = function locals(req, res, next) {
  let lang = req.query.lang;
  if (lang && config.languages.includes(lang)) {
    res.cookie('lang', lang, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax' });
  } else {
    lang = config.languages.includes(req.cookies.lang) ? req.cookies.lang : config.defaultLang;
  }
  req.lang = lang;
  const s = settings.all();
  res.locals.lang = lang;
  res.locals.languages = config.languages;
  res.locals.t = i18n.translator(lang);
  res.locals.field = (row, base) => i18n.field(row, base, lang);
  res.locals.settings = s;
  // Danh sách banner trang chủ: banner chính + banner trình chiếu
  let extra = [];
  try { extra = JSON.parse(s.banners || '[]'); } catch { extra = []; }
  res.locals.bannerList = [s.banner_url, ...(Array.isArray(extra) ? extra : [])].filter(Boolean);
  res.locals.contact = contact.links(s.phone);
  res.locals.fmt = fmt;
  res.locals.icon = icon;
  res.locals.path = req.path;
  // Link đổi ngôn ngữ giữ nguyên trang hiện tại
  res.locals.langUrl = l => {
    const u = new URL(req.originalUrl, 'http://x');
    u.searchParams.set('lang', l);
    return u.pathname + u.search;
  };
  next();
};

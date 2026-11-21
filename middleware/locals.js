'use strict';
// Biến dùng chung cho mọi view: settings, ngôn ngữ, hàm format
const config = require('../config');
const settings = require('../services/settings');
const i18n = require('../services/i18n');
const fmt = require('../services/format');

module.exports = function locals(req, res, next) {
  let lang = req.query.lang;
  if (lang && config.languages.includes(lang)) {
    res.cookie('lang', lang, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax' });
  } else {
    lang = config.languages.includes(req.cookies.lang) ? req.cookies.lang : config.defaultLang;
  }
  req.lang = lang;
  res.locals.lang = lang;
  res.locals.languages = config.languages;
  res.locals.t = i18n.translator(lang);
  res.locals.settings = settings.all();
  res.locals.fmt = fmt;
  res.locals.path = req.path;
  next();
};

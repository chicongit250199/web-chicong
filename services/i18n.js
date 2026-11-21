'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');

const dicts = {};
for (const l of config.languages) {
  const f = path.join(__dirname, '..', 'locales', `${l}.json`);
  dicts[l] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

// t('nav.login') -> chuỗi theo ngôn ngữ, fallback tiếng Việt, rồi key
function translator(lang) {
  const d = dicts[lang] || {};
  const vi = dicts.vi;
  return (key, vars) => {
    let s = d[key] ?? vi[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
    return s;
  };
}

// Lấy trường đa ngôn ngữ từ bản ghi DB: field(p, 'name', 'en') -> p.name_en || p.name_vi
function field(row, base, lang) {
  return (row && (row[`${base}_${lang}`] || row[`${base}_vi`])) || '';
}

module.exports = { translator, field };

'use strict';
// Kiểm tra dữ liệu form ở backend (zod)
const { z } = require('zod');
const fmt = require('./format');

const text = (max = 1000) => z.preprocess(v => (v == null ? '' : String(v)), z.string().trim().max(max, `Tối đa ${max} ký tự`))
  .transform(v => v || null);
const reqText = (msg, max = 1000) => z.preprocess(v => (v == null ? '' : String(v)), z.string().trim().min(1, msg).max(max, `Tối đa ${max} ký tự`));
const phone = (required = true) => z.preprocess(v => String(v == null ? '' : v).replace(/[^\d+]/g, ''),
  required ? z.string().min(8, 'Số điện thoại không hợp lệ').max(15, 'Số điện thoại không hợp lệ')
    : z.string().max(15, 'Số điện thoại không hợp lệ').transform(v => v || null));
const money = z.preprocess(v => fmt.parseMoney(v), z.number().int().min(0, 'Số tiền không hợp lệ').nullable());
const date = z.preprocess(v => (v == null || v === '' ? null : String(v)), z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Ngày không hợp lệ').nullable());
const oneOf = (values, msg = 'Giá trị không hợp lệ') => z.preprocess(v => (v == null ? '' : String(v)), z.string().refine(v => values.includes(v), msg));
const intOneOf = (values, msg = 'Giá trị không hợp lệ') => z.coerce.number().int().refine(v => values.includes(v), msg);
const intOpt = z.preprocess(v => (v === '' || v == null ? null : Number(v)), z.number().int().min(0).nullable());

function parse(schema, body) {
  const r = schema.safeParse(body || {});
  if (r.success) return { data: r.data };
  return { error: [...new Set(r.error.issues.map(i => i.message))].join(' · ') };
}

const WARRANTY_OPTIONS = [0, 1, 3, 6, 9, 12, 24, 36];

module.exports = { z, text, reqText, phone, money, date, oneOf, intOneOf, intOpt, parse, WARRANTY_OPTIONS };

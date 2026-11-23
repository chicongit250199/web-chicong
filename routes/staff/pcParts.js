'use strict';
// Nhân viên: xem bảng Giá Linh Kiện (chỉ xem) + gửi yêu cầu nhập hàng -> món chuyển "Chờ nhập kho", báo quản lý
const express = require('express');
const db = require('../../db');
const v = require('../../services/validate');
const pc = require('../../services/pcParts');
const { notify } = require('../../services/events');
const { renderList } = require('../manager/pcParts');

const router = express.Router();

router.get('/pc-parts', (req, res) => {
  if (req.user.role === 'manager') return res.redirect('/manager/pc-parts'); // quản lý dùng trang sửa được
  res.locals.nav = 'pc-parts-view';
  renderList(req, res, false);
});

const reqSchema = v.z.object({
  qty: v.z.preprocess(x => (x === '' || x == null ? 1 : Number(x)), v.z.number().int().min(1, 'Số lượng từ 1').max(100, 'Tối đa 100')),
  note: v.text(300),
});
router.post('/pc-parts/:id/request', (req, res) => {
  const part = db.prepare('SELECT * FROM pc_parts WHERE id = ?').get(req.params.id);
  if (!part) return res.status(404).json({ error: 'Không tìm thấy linh kiện' });
  const { data, error } = v.parse(reqSchema, req.body);
  if (error) return res.status(422).json({ error });
  const stock = pc.stockInfo().byPart.get(part.id)?.qty || 0;
  db.prepare(`UPDATE pc_parts SET req_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), req_by = ?, req_qty = ?, req_note = ?, req_stock = ? WHERE id = ?`)
    .run(req.user.full_name, data.qty, data.note || null, stock, part.id);
  notify('inventory', `${req.user.full_name} yêu cầu nhập ${data.qty} × ${pc.displayName(part)}${data.note ? ' — ' + data.note : ''}`.slice(0, 400),
    '/manager/pc-parts?req=1', req.user.full_name, 'manager', { kind: 'stock_request' });
  res.json({ ok: true, message: `Đã gửi yêu cầu nhập ${data.qty} × ${part.name}. Món này đang ở trạng thái Chờ nhập kho.` });
});

module.exports = router;

'use strict';
// Đọc XML hóa đơn điện tử theo chuẩn Tổng cục Thuế (TT78/NĐ123) — dùng chung cho MISA, Viettel, FastCA, VNPT, BKAV...
// Cấu trúc: HDon > DLHDon > { TTChung, NDHDon > { NBan, NMua, DSHHDVu > HHDVu[], TToan } }
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true,
  isArray: name => name === 'HHDVu' || name === 'TTin' || name === 'LTSuat',
});

function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  if (obj[key]) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findKey(v, key, depth + 1);
    if (r) return r;
  }
  return null;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
const int = v => { const n = num(v); return n == null ? null : Math.round(n); };
const str = v => (v == null ? '' : String(v).trim());

function parseInvoiceXml(buffer) {
  let doc;
  try { doc = parser.parse(buffer.toString('utf8')); } catch { return null; }
  const dl = findKey(doc, 'DLHDon');
  if (!dl) return null;
  const tt = dl.TTChung || {};
  const nd = dl.NDHDon || {};
  const nban = nd.NBan || {};
  const nmua = nd.NMua || {};
  const toan = nd.TToan || {};
  const rows = (nd.DSHHDVu && nd.DSHHDVu.HHDVu) || [];

  const items = rows
    // TChat: 1 hàng hóa/dịch vụ, 2 khuyến mại, 3 chiết khấu, 4 ghi chú
    .filter(r => !r.TChat || ['1', '2'].includes(str(r.TChat)))
    .map(r => ({
      name: str(r.THHDVu), unit: str(r.DVTinh),
      quantity: num(r.SLuong) ?? 0, unit_price: int(r.DGia), amount: int(r.ThTien), vat_rate: str(r.TSuat),
    }))
    .filter(r => r.name);

  return {
    invoice_symbol: str(tt.KHMSHDon) + str(tt.KHHDon),
    invoice_number: str(tt.SHDon),
    invoice_date: str(tt.NLap).slice(0, 10),
    seller_name: str(nban.Ten), seller_tax_id: str(nban.MST),
    buyer_name: str(nmua.Ten || nmua.HVTNMHang), buyer_tax_id: str(nmua.MST),
    subtotal: int(toan.TgTCThue), vat_amount: int(toan.TgTThue),
    total_amount: int(toan.TgTTTBSo),
    items,
  };
}

module.exports = { parseInvoiceXml };

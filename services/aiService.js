'use strict';
// Gemini AI: viết mô tả sản phẩm, dịch đa ngôn ngữ, bóc tách hóa đơn VAT (PDF/ảnh/XML lạ)
const config = require('../config');

let client = null;
function ai() {
  if (!config.geminiApiKey) {
    const e = new Error('Chưa cấu hình GEMINI_API_KEY trong file .env');
    e.status = 400; e.expose = true;
    throw e;
  }
  if (!client) {
    const { GoogleGenAI } = require('@google/genai'); // nạp khi cần để tiết kiệm RAM lúc khởi động
    client = new GoogleGenAI({ apiKey: config.geminiApiKey, httpOptions: { apiVersion: 'v1beta' } });
  }
  return client;
}

function isEnabled() { return Boolean(config.geminiApiKey); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

const busy = e => [429, 500, 503].includes(Number(e.status || e.code || (String(e.message).match(/\b(429|500|503)\b/) || [])[1]));

// Model chính bận (503 quá tải / 429 hết lượt) -> chuyển ngay sang model dự phòng;
// tất cả đều bận -> chờ rồi thử lại cả vòng (tối đa 3 vòng)
// Nhớ model vừa chạy được trong 10 phút để không phải thử lại model đang quá tải mỗi lần
let preferred = null; let preferredUntil = 0;

async function withFallback(call) {
  let models = [...new Set([config.geminiModel, ...config.geminiFallbackModels])];
  if (preferred && Date.now() < preferredUntil) models = [preferred, ...models.filter(m => m !== preferred)];
  for (let round = 1; ; round++) {
    let lastErr;
    for (const model of models) {
      try {
        const r = await call(model);
        if (model !== config.geminiModel) { preferred = model; preferredUntil = Date.now() + 10 * 60 * 1000; } else preferred = null;
        return r;
      } catch (e) {
        if (!busy(e)) throw e;
        lastErr = e;
        if (model === preferred) preferred = null;
        console.warn(`[ai] ${model} bận (${e.status || e.code}), thử model khác`);
      }
    }
    if (round >= 3) throw lastErr;
    await sleep(10000 * round);
  }
}

async function generateJson(parts, schema, systemInstruction) {
  const res = await withFallback(model => ai().models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      temperature: 0.2,
    },
  }));
  const text = res.text || '';
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('AI trả về dữ liệu không hợp lệ');
  }
}

// ---- Sản phẩm ----
async function writeProductDescription({ name, specs, category, price }) {
  const out = await generateJson(
    [{ text: `Tên sản phẩm: ${name}\nDanh mục: ${category || ''}\nCấu hình / thông số:\n${specs || '(không có)'}\nGiá: ${price ? price + ' VNĐ' : 'liên hệ'}` }],
    { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
    'Bạn là chuyên viên nội dung của cửa hàng máy tính Chí Công Computer tại Đà Nẵng. ' +
    'Viết mô tả sản phẩm tiếng Việt, chuẩn SEO, 120-220 từ, giọng chuyên nghiệp và thân thiện. ' +
    'Gồm: đoạn giới thiệu ngắn, 3-6 gạch đầu dòng điểm nổi bật (bắt đầu bằng "• "), câu kết mời liên hệ. ' +
    'Chỉ dùng thông tin được cung cấp, không bịa thông số. Văn bản thuần, không markdown.',
  );
  return String(out.description || '').trim();
}

async function translateProduct({ name, desc }) {
  const lang = { type: 'object', properties: { name: { type: 'string' }, desc: { type: 'string' } }, required: ['name', 'desc'] };
  return generateJson(
    [{ text: JSON.stringify({ name, desc: desc || '' }) }],
    { type: 'object', properties: { en: lang, ru: lang, zh: lang }, required: ['en', 'ru', 'zh'] },
    'Dịch tên và mô tả sản phẩm máy tính từ tiếng Việt sang tiếng Anh (en), tiếng Nga (ru), tiếng Trung giản thể (zh). ' +
    'Giữ nguyên tên thương hiệu, mã model, thông số kỹ thuật và ký tự "• ". Giữ nguyên xuống dòng.',
  );
}

// ---- Hóa đơn VAT ----
const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    invoice_symbol: { type: 'string', description: 'Ký hiệu hóa đơn, ví dụ 1C24TAA' },
    invoice_number: { type: 'string' },
    invoice_date: { type: 'string', description: 'YYYY-MM-DD' },
    seller_name: { type: 'string' }, seller_tax_id: { type: 'string' },
    buyer_name: { type: 'string' }, buyer_tax_id: { type: 'string' },
    subtotal: { type: 'number', description: 'Tổng tiền trước thuế (VNĐ)' },
    vat_amount: { type: 'number' },
    total_amount: { type: 'number', description: 'Tổng thanh toán (VNĐ)' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, unit: { type: 'string' },
          quantity: { type: 'number' }, unit_price: { type: 'number' },
          amount: { type: 'number', description: 'Thành tiền trước thuế' }, vat_rate: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  required: ['invoice_number', 'items'],
};

async function extractInvoice(buffer, mimeType) {
  const parts = mimeType.includes('xml') || mimeType.startsWith('text/')
    ? [{ text: 'Nội dung XML hóa đơn:\n' + buffer.toString('utf8').slice(0, 200000) }]
    : [{ inlineData: { mimeType, data: buffer.toString('base64') } }];
  parts.push({ text: 'Bóc tách thông tin hóa đơn giá trị gia tăng (VAT) Việt Nam này.' });
  return generateJson(parts, INVOICE_SCHEMA,
    'Bạn bóc tách hóa đơn điện tử Việt Nam (MISA, Viettel, FPT, VNPT, FastCA, BKAV, EasyInvoice...). ' +
    'Số tiền là số nguyên VNĐ (bỏ dấu chấm phân cách nghìn). Ngày dạng YYYY-MM-DD. ' +
    'Chỉ liệt kê dòng hàng hóa/dịch vụ thật, bỏ dòng chiết khấu/ghi chú. Không đoán nếu không có, để trống.');
}

module.exports = { isEnabled, writeProductDescription, translateProduct, extractInvoice };

'use strict';
// Gemini AI: viết mô tả sản phẩm, dịch đa ngôn ngữ, bóc tách hóa đơn VAT (PDF/ảnh/XML lạ)
const config = require('../config');

// Mỗi key 1 client (nạp thư viện khi cần để tiết kiệm RAM lúc khởi động)
const clients = new Map();
function clientFor(key) {
  if (!clients.has(key)) {
    const { GoogleGenAI } = require('@google/genai');
    clients.set(key, new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: 'v1beta' } }));
  }
  return clients.get(key);
}

function isEnabled() { return config.geminiApiKeys.length > 0; }

const sleep = ms => new Promise(r => setTimeout(r, ms));

const busy = e => [429, 500, 503].includes(Number(e.status || e.code || (String(e.message).match(/\b(429|500|503)\b/) || [])[1]));

// Thứ tự thử: key 1 (model chính -> dự phòng) -> key 2 (model chính -> dự phòng).
// Lỗi bận (503 quá tải / 429 hết lượt) -> thử cặp tiếp theo ngay; tất cả đều bận -> chờ rồi thử lại cả vòng (tối đa 3 vòng).
// Nhớ cặp key+model vừa chạy được trong 10 phút để không phải thử lại cặp đang bận mỗi lần.
let preferred = null; let preferredUntil = 0;
const keyName = k => 'key ' + (config.geminiApiKeys.indexOf(k) + 1);

async function withFallback(call) {
  if (!isEnabled()) {
    const e = new Error('Chưa cấu hình GEMINI_API_KEY trong file .env');
    e.status = 400; e.expose = true;
    throw e;
  }
  const models = [...new Set([config.geminiModel, ...config.geminiFallbackModels])];
  let pairs = config.geminiApiKeys.flatMap(key => models.map(model => ({ key, model, id: key + '|' + model })));
  const first = pairs[0].id;
  for (let round = 1; ; round++) {
    if (preferred && Date.now() < preferredUntil) pairs = [...pairs.filter(p => p.id === preferred), ...pairs.filter(p => p.id !== preferred)];
    let lastErr;
    for (const p of pairs) {
      try {
        const r = await call(p.model, clientFor(p.key));
        if (p.id !== first) { preferred = p.id; preferredUntil = Date.now() + 10 * 60 * 1000; } else preferred = null;
        return r;
      } catch (e) {
        if (!busy(e)) throw e;
        lastErr = e;
        if (p.id === preferred) preferred = null;
        console.warn(`[ai] ${p.model} (${keyName(p.key)}) bận (${e.status || e.code}), thử tiếp`);
      }
    }
    if (round >= 3) throw lastErr;
    await sleep(10000 * round);
  }
}

async function generateJson(parts, schema, systemInstruction) {
  const res = await withFallback((model, ai) => ai.models.generateContent({
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

// Tra cứu thông số thật của model trên Google (grounding) rồi viết bài giới thiệu chi tiết.
// Google Search không dùng chung được với responseJsonSchema -> yêu cầu JSON trong văn bản rồi tự tách.
async function researchProduct({ name, specs, category, price, condition }) {
  const prompt = [
    `Sản phẩm: ${name}`,
    category ? `Danh mục: ${category}` : '',
    condition ? `Tình trạng: ${condition}` : '',
    price ? `Giá bán tại cửa hàng: ${price} VNĐ` : '',
    specs ? `Thông tin cửa hàng đã có (ưu tiên giữ đúng, nhất là cấu hình cụ thể của máy này):\n${specs}` : '',
    '',
    'Hãy TÌM TRÊN GOOGLE thông số kỹ thuật chính thức của đúng model này (trang hãng, trang review / bán lẻ uy tín), rồi trả về DUY NHẤT một khối JSON:',
    '{"specs": "...", "description": "..."}',
    '- specs: thông số chi tiết, mỗi dòng "Tên: giá trị" (CPU, RAM, Ổ cứng, Màn hình, Card đồ họa, Cổng kết nối, Wifi/Bluetooth, Pin, Trọng lượng, Hệ điều hành...). Với máy có nhiều cấu hình, dùng cấu hình cửa hàng đã ghi; thông số không chắc thì bỏ qua, KHÔNG bịa.',
    '- description: bài giới thiệu tiếng Việt 250-400 từ, chuẩn SEO, giọng chuyên nghiệp thân thiện, gồm: đoạn mở đầu; các phần có tiêu đề ngắn viết HOA ở đầu dòng (THIẾT KẾ, HIỆU NĂNG, MÀN HÌNH, PIN & KẾT NỐI — chọn phần phù hợp loại sản phẩm); 3-5 gạch đầu dòng điểm nổi bật bắt đầu bằng "• "; đoạn "PHÙ HỢP VỚI" nói rõ đối tượng; câu kết mời liên hệ Chí Công Computer (Đà Nẵng). Văn bản thuần, không markdown, không dấu *, không link.',
  ].filter(Boolean).join('\n');

  const res = await withFallback((model, ai) => ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0.3,
      systemInstruction: 'Bạn là chuyên viên nội dung của cửa hàng máy tính Chí Công Computer. Chỉ dùng thông tin tìm được từ nguồn đáng tin; không chắc thì không ghi.',
    },
  }));
  const text = (res.text || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw Object.assign(new Error('AI không trả về đúng định dạng, thử lại.'), { status: 502, expose: true });
  let out;
  try { out = JSON.parse(m[0]); } catch {
    // Một số model để xuống dòng thật trong chuỗi JSON -> thay bằng \n rồi đọc lại
    out = JSON.parse(m[0].replace(/"((?:[^"\\]|\\.)*)"/gs, (s, inner) => '"' + inner.replace(/\r?\n/g, '\\n') + '"'));
  }
  const clean = s => String(s || '').replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim();
  const chunks = (res.candidates && res.candidates[0] && res.candidates[0].groundingMetadata && res.candidates[0].groundingMetadata.groundingChunks) || [];
  const sources = [...new Map(chunks.filter(c => c.web && c.web.uri).map(c => [c.web.title || c.web.uri, { title: c.web.title || c.web.uri, uri: c.web.uri }])).values()].slice(0, 8);
  return { specs: clean(out.specs), description: clean(out.description), sources };
}

// Build PC: tra thông số chính thức của 1 linh kiện theo bộ trường của nhóm (fields: [[key, nhãn, gợi ý]])
async function researchPcPart({ name, category, condition, fields }) {
  const prompt = [
    `Linh kiện máy tính: ${name}`,
    `Nhóm: ${category}`,
    condition ? `Tình trạng: ${condition}` : '',
    '',
    'Hãy TÌM TRÊN GOOGLE thông số chính thức của đúng model này (ưu tiên trang của hãng sản xuất), rồi trả về DUY NHẤT một khối JSON:',
    '{"specs": {' + fields.map(([k]) => `"${k}": "..."`).join(', ') + '}, "summary": "...", "maker_url": "..."}',
    'Ý nghĩa các trường specs:',
    ...fields.map(([k, label, hint]) => `- ${k}: ${label}${hint ? ' (' + hint + ')' : ''}`),
    '- Giá trị ngắn gọn (VD "LGA1700", "DDR4", "650"). Trường chỉ số W/mm chỉ ghi số. Không chắc hoặc không áp dụng thì để chuỗi rỗng "", KHÔNG bịa.',
    '- Tên chung chung không rõ model (VD "RAM DDR4 8G 3200", "Main H310") thì điền thông số chung của loại đó, bỏ trống phần phụ thuộc hãng.',
    '- summary: 1-2 câu tiếng Việt giới thiệu điểm nổi bật và phù hợp nhu cầu gì (văn bản thuần, không markdown).',
    '- maker_url: link trang sản phẩm trên web hãng nếu tìm thấy, không có thì "".',
  ].filter(Boolean).join('\n');
  const res = await withFallback((model, ai) => ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { tools: [{ googleSearch: {} }], temperature: 0.1, systemInstruction: 'Bạn là kỹ thuật viên phần cứng máy tính. Chỉ dùng thông tin tìm được từ nguồn đáng tin; không chắc thì để trống.' },
  }));
  const text = (res.text || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw Object.assign(new Error('AI không trả về đúng định dạng, thử lại.'), { status: 502, expose: true });
  let out;
  try { out = JSON.parse(m[0]); } catch {
    out = JSON.parse(m[0].replace(/"((?:[^"\\]|\\.)*)"/gs, (x, inner) => '"' + inner.replace(/\r?\n/g, ' ') + '"'));
  }
  const specs = {};
  for (const [k] of fields) {
    const v = out.specs && out.specs[k];
    if (v != null && String(v).trim() && !/^(n\/a|không rõ|unknown|-)$/i.test(String(v).trim())) specs[k] = String(v).replace(/\*\*/g, '').trim().slice(0, 200);
  }
  const chunks = (res.candidates && res.candidates[0] && res.candidates[0].groundingMetadata && res.candidates[0].groundingMetadata.groundingChunks) || [];
  const sources = [...new Map(chunks.filter(c => c.web && c.web.uri).map(c => [c.web.title || c.web.uri, { title: c.web.title || c.web.uri, uri: c.web.uri }])).values()].slice(0, 6);
  const maker = /^https?:\/\//.test(String(out.maker_url || '')) ? String(out.maker_url) : '';
  if (maker) sources.unshift({ title: 'Trang hãng', uri: maker });
  return { specs, summary: String(out.summary || '').replace(/\*\*/g, '').trim().slice(0, 600), sources };
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

// ---- Chat có gọi công cụ (Zalo Bot): AI tự gọi hàm tra dữ liệu, ta chạy hàm rồi trả kết quả cho AI viết câu trả lời ----
// tools: [{ name, description, parameters (JSON Schema) }]; run(name, args) → object kết quả (chạy đồng bộ / async)
// history: [{ role: 'user' | 'model', text }] các lượt trước. Tối đa maxSteps lượt gọi hàm. forceTool: lượt đầu bắt buộc gọi hàm.
async function chatWithTools({ system, history = [], text, tools = [], run, maxSteps = 5, forceTool = false }) {
  const contents = [...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })), { role: 'user', parts: [{ text }] }];
  const decl = tools.length ? [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] : undefined;
  const used = [];
  for (let step = 0; ; step++) {
    const last = step >= maxSteps || !decl;
    const mode = last ? 'NONE' : forceTool && step === 0 ? 'ANY' : null; // ANY = bắt buộc gọi hàm ở lượt đầu
    const res = await withFallback((model, ai) => ai.models.generateContent({
      model, contents,
      config: { systemInstruction: system, temperature: 0.2, ...(decl ? { tools: decl } : {}), ...(decl && mode ? { toolConfig: { functionCallingConfig: { mode } } } : {}) },
    }));
    const calls = res.functionCalls || [];
    if (!calls.length || last) return { text: (res.text || '').trim(), used };
    contents.push(res.candidates[0].content);
    const parts = [];
    for (const c of calls) {
      let result;
      try { result = await run(c.name, c.args || {}); } catch (e) { result = { loi: e.message }; }
      used.push(c.name + JSON.stringify(c.args || {}).slice(0, 120));
      parts.push({ functionResponse: { id: c.id, name: c.name, response: { result } } });
    }
    contents.push({ role: 'user', parts });
  }
}

module.exports = { isEnabled, chatWithTools, writeProductDescription, researchProduct, researchPcPart, translateProduct, extractInvoice };

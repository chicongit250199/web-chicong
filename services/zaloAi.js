'use strict';
// Trợ lý AI (Gemini) cho Zalo Bot — CHỈ ĐỌC dữ liệu, không sửa / xóa / bán gì.
//  - Nhân viên / quản lý (nhắn riêng): hỏi tự nhiên về kho, báo giá, máy đang sửa, task quá hạn;
//    quản lý hỏi thêm doanh thu / chi phí / công nợ. AI tự gọi các hàm tra cứu bên dưới.
//  - Đối tác (nhóm / nhắn riêng): chỉ tra được máy của CHÍNH đối tác đó, lời lẽ gửi khách, không lộ thông tin nội bộ.
// Số liệu luôn lấy từ DB qua hàm tra cứu; AI chỉ diễn đạt. Lỗi AI → zaloBot dùng câu trả lời theo luật cũ.
const db = require('../db');
const ai = require('./aiService');
const settings = require('./settings');
const fmt = require('./format');
const invCat = require('./invCategory');

const HISTORY_TURNS = 8, HISTORY_TTL = 30 * 60e3, LIMIT = 25;
const history = new Map(); // chatId → { at, turns: [{ role, text }] }

function isOn() { return ai.isEnabled() && settings.get('zalo_ai') !== '0'; }
function setOn(on) { settings.set({ zalo_ai: on ? '1' : '0' }); }

// ---------- tiện ích ----------
const flat = t => ' ' + (db.vn(t) || '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const terms = s => [...new Set(flat(s).trim().split(' ').filter(Boolean))];
const hit = (ws, hay) => ws.every(w => hay.includes(' ' + w) || (/\d/.test(w) && hay.includes(w)));
const money = n => (n == null ? null : fmt.money(n));
const vnDay = iso => (iso ? new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 10) : null);
const ymd = s => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null);
const todayVn = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const STATUS = { pending: 'chờ sửa', processing: 'đang sửa', done: 'sửa xong, chờ khách nhận', unrepairable: 'không sửa được, chờ khách nhận', completed: 'đã trả máy' };
const CAT_KEYS = invCat.CATEGORIES.map(c => c.key);
const catLabel = k => (invCat.CATEGORIES.find(c => c.key === k) || {}).label || k;

function cut(rows, n = LIMIT) { return { tong_so: rows.length, ds: rows.slice(0, n), ...(rows.length > n ? { ghi_chu: `chỉ hiện ${n}/${rows.length}, hỏi cụ thể hơn để lọc` } : {}) }; }

// ---------- hàm tra cứu: nhân viên + quản lý ----------
const q = {
  stock: db.prepare(`SELECT name, item_code, condition, supplier, tech_price, retail_price, warranty_out_months, COUNT(*) qty, MIN(import_date) import_date
    FROM inventory_items WHERE status = 'in_stock' GROUP BY name, condition, tech_price, retail_price ORDER BY name`),
  sold: db.prepare(`SELECT name, serial, condition, retail_price, sold_date, customer_name, customer_phone FROM inventory_items
    WHERE status = 'sold' AND (@from IS NULL OR sold_date >= @from) AND (@to IS NULL OR sold_date <= @to) ORDER BY sold_date DESC, id DESC LIMIT 3000`),
  parts: db.prepare('SELECT id, category, name, condition, price, warranty_months, note_public FROM pc_parts WHERE hidden = 0 ORDER BY category, sort, id'),
  tasks: db.prepare(`SELECT t.*, u.full_name AS tech, p.name AS partner FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to
    LEFT JOIN partners p ON p.id = t.partner_id ORDER BY t.created_at DESC LIMIT 3000`),
};

const stockRow = r => ({ ten: r.name, danh_muc: catLabel(invCat.categorize(r.name)), tinh_trang: r.condition || null, so_luong: r.qty,
  gia_kt: money(r.tech_price), gia_le: money(r.retail_price), bh_thang: r.warranty_out_months, npp: r.supplier || null, nhap_tu: r.import_date });

const STAFF_TOOLS = [
  {
    name: 'tim_kho',
    description: 'Tra hàng trong kho (linh kiện, laptop, màn hình...). Mặc định hàng còn tồn (gộp cùng tên + giá, có số lượng, giá KT = giá kỹ thuật/giá sỉ, giá lẻ). da_ban=true để xem hàng đã bán (kèm ngày bán, khách).',
    parameters: { type: 'object', properties: {
      tu_khoa: { type: 'string', description: 'tên / model / serial, VD "ram 8gb ddr4", "i5 12400", "h610". Bỏ trống = tất cả' },
      danh_muc: { type: 'string', enum: CAT_KEYS, description: 'main, cpu, ram, vga, storage (ổ cứng SSD/HDD), psu (nguồn), case, cooling (tản nhiệt), monitor, gear (phím chuột tai nghe), laptop, pc, other' },
      da_ban: { type: 'boolean' },
      tu_ngay: { type: 'string', description: 'YYYY-MM-DD, chỉ dùng khi da_ban' },
      den_ngay: { type: 'string', description: 'YYYY-MM-DD, chỉ dùng khi da_ban' },
    } },
  },
  {
    name: 'thong_ke_kho',
    description: 'Tổng quan tồn kho: số món và giá trị tồn theo từng danh mục.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'bao_gia',
    description: 'Bảng báo giá linh kiện của cửa hàng (dùng để báo giá / ráp PC): giá bán, tình trạng, bảo hành, số đang có trong kho.',
    parameters: { type: 'object', properties: {
      tu_khoa: { type: 'string', description: 'VD "main b760", "ram 16gb", "3060"' },
      nhom: { type: 'string', description: 'nhóm: Main, CPU, RAM, VGA, Ổ Cứng, Nguồn, Vỏ Case, Màn Hình, Bàn Phím, Chuột, Phụ kiện' },
    } },
  },
  {
    name: 'tim_may_sua',
    description: 'Tra máy/thiết bị khách gửi sửa (task sửa chữa): tình trạng, lỗi, kỹ thuật viên, chi phí, ngày nhận/trả. Tìm theo tên máy, tên khách, SĐT, mã phiếu, tên đối tác.',
    parameters: { type: 'object', properties: {
      tu_khoa: { type: 'string' },
      trang_thai: { type: 'string', enum: ['dang_o_cua_hang', 'pending', 'processing', 'done', 'unrepairable', 'completed'],
        description: 'dang_o_cua_hang = chưa trả khách (chờ sửa, đang sửa, sửa xong, không sửa được)' },
      tu_ngay: { type: 'string', description: 'ngày nhận máy từ (YYYY-MM-DD)' },
      den_ngay: { type: 'string', description: 'ngày nhận máy đến (YYYY-MM-DD)' },
    } },
  },
  {
    name: 'task_qua_han',
    description: 'Danh sách task sửa chữa đang quá hạn (để lâu chưa làm / chưa xong), kèm người được giao.',
    parameters: { type: 'object', properties: {} },
  },
];

const MANAGER_TOOLS = [
  {
    name: 'doanh_thu',
    description: 'Doanh thu (bán hàng + sửa chữa), chi phí, thu nợ trong khoảng ngày (giờ VN). Hỏi "hôm nay" thì tu_ngay = den_ngay = hôm nay.',
    parameters: { type: 'object', properties: {
      tu_ngay: { type: 'string', description: 'YYYY-MM-DD' }, den_ngay: { type: 'string', description: 'YYYY-MM-DD' },
      chi_tiet: { type: 'boolean', description: 'true = kèm danh sách từng giao dịch (tối đa 25)' },
    }, required: ['tu_ngay', 'den_ngay'] },
  },
  {
    name: 'cong_no',
    description: 'Công nợ khách hàng / đối tác: ai đang nợ bao nhiêu, tổng còn nợ.',
    parameters: { type: 'object', properties: { tu_khoa: { type: 'string', description: 'tên / SĐT người nợ, bỏ trống = tất cả' } } },
  },
];

function taskRow(t, internal) {
  const r = { phieu: t.ticket_code, may: t.device_model, cau_hinh: t.specs || null, loi: t.issue_desc, trang_thai: STATUS[t.status] || t.status,
    ngay_nhan: vnDay(t.created_at), hen_tra: t.expected_return_date || null, gia_du_kien: money(t.estimated_price),
    chi_phi: money(t.final_price), ly_do_khong_sua: t.fail_reason || null, ngay_tra: t.status === 'completed' ? vnDay(t.completed_at) : null };
  if (internal) Object.assign(r, { khach: t.customer_name || null, sdt: t.customer_phone, doi_tac: t.partner || null, ky_thuat: t.tech || null,
    da_sua: t.repair_detail || null, linh_kien_thay: t.replaced_parts || null, ghi_chu: t.note || null });
  return r;
}

function runStaff(user, name, a) {
  const ws = terms(a.tu_khoa || '');
  if (name === 'tim_kho') {
    const cat = CAT_KEYS.includes(a.danh_muc) ? a.danh_muc : null;
    const okCat = n => !cat || invCat.categorize(n) === cat;
    if (a.da_ban) {
      const rows = q.sold.all({ from: ymd(a.tu_ngay), to: ymd(a.den_ngay) })
        .filter(r => okCat(r.name) && hit(ws, flat(`${r.name} ${r.serial || ''} ${r.customer_name || ''} ${r.customer_phone || ''}`)))
        .map(r => ({ ten: r.name, serial: r.serial, tinh_trang: r.condition, gia_le: money(r.retail_price), ngay_ban: r.sold_date, khach: r.customer_name, sdt: r.customer_phone }));
      return cut(rows);
    }
    const rows = q.stock.all().filter(r => okCat(r.name) && hit(ws, flat(`${r.name} ${r.item_code || ''} ${r.condition || ''} ${r.supplier || ''}`))).map(stockRow);
    return { tong_so_mon: rows.reduce((s, r) => s + r.so_luong, 0), ...cut(rows) };
  }
  if (name === 'thong_ke_kho') {
    const by = new Map();
    for (const r of q.stock.all()) {
      const k = catLabel(invCat.categorize(r.name));
      const o = by.get(k) || { danh_muc: k, so_mon: 0, gia_tri_kt: 0, gia_tri_le: 0 };
      o.so_mon += r.qty; o.gia_tri_kt += (r.tech_price || 0) * r.qty; o.gia_tri_le += (r.retail_price || 0) * r.qty;
      by.set(k, o);
    }
    const ds = [...by.values()].map(o => ({ ...o, gia_tri_kt: money(o.gia_tri_kt), gia_tri_le: money(o.gia_tri_le) }));
    return { tong_so_mon: ds.reduce((s, o) => s + o.so_mon, 0), ds };
  }
  if (name === 'bao_gia') {
    let stock = new Map();
    try { stock = require('./pcParts').stockInfo().byPart; } catch { /* bỏ qua */ }
    const g = a.nhom ? flat(a.nhom) : null;
    const rows = q.parts.all().filter(r => (!g || flat(r.category) === g) && hit(ws, flat(`${r.category} ${r.name} ${r.condition || ''}`)))
      .map(r => ({ nhom: r.category, ten: r.name, tinh_trang: r.condition, gia: money(r.price) || 'liên hệ', bh_thang: r.warranty_months,
        ghi_chu: r.note_public || null, kho_co: (stock.get(r.id) || {}).qty || 0 }));
    return cut(rows, 30);
  }
  if (name === 'tim_may_sua') {
    const st = a.trang_thai, from = ymd(a.tu_ngay), to = ymd(a.den_ngay);
    const rows = q.tasks.all().filter(t => {
      if (st === 'dang_o_cua_hang' ? t.status === 'completed' : st && t.status !== st) return false;
      const d = vnDay(t.created_at);
      if ((from && d < from) || (to && d > to)) return false;
      return hit(ws, flat(`${t.ticket_code} ${t.device_model} ${t.specs || ''} ${t.issue_desc} ${t.customer_name || ''} ${t.customer_phone} ${t.partner || ''} ${t.tech || ''}`));
    }).map(t => taskRow(t, true));
    return cut(rows, 20);
  }
  if (name === 'task_qua_han') {
    const ta = require('./taskAlerts');
    settings.all(); // nạp cache settings trước: task_alert_days đọc settings giữa lúc query chạy
    const rows = db.prepare(`SELECT t.ticket_code, t.device_model, t.status, ${ta.AGE} AS age, u.full_name AS tech FROM tasks t
      LEFT JOIN users u ON u.id = t.assigned_to WHERE ${ta.OVERDUE_WHERE} ORDER BY age DESC LIMIT 50`).all()
      .map(t => ({ phieu: t.ticket_code, may: t.device_model, trang_thai: STATUS[t.status], so_ngay_lam_viec_de_lau: Math.round(t.age * 10) / 10, giao_cho: t.tech || 'chưa giao' }));
    return cut(rows, 30);
  }
  if (user.role !== 'manager') return { loi: 'Chỉ quản lý được xem thông tin này.' };
  if (name === 'doanh_thu') {
    const from = ymd(a.tu_ngay) || todayVn(), to = ymd(a.den_ngay) || from;
    const D = `date(created_at, '+7 hours') BETWEEN ? AND ?`;
    const rev = db.prepare(`SELECT type, payment_method, COUNT(*) n, COALESCE(SUM(amount),0) s FROM revenues WHERE ${D} GROUP BY type, payment_method`).all(from, to);
    const sum = f => rev.filter(f).reduce((x, r) => x + r.s, 0);
    const exp = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM expenses WHERE expense_date BETWEEN ? AND ?').get(from, to);
    let debtPaid = 0;
    try { debtPaid = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM debt_payments WHERE ${D}`).get(from, to).s; } catch { /* chưa có bảng */ }
    const out = {
      tu_ngay: from, den_ngay: to, so_giao_dich: rev.reduce((x, r) => x + r.n, 0),
      tong_doanh_thu: money(sum(() => true)), ban_hang: money(sum(r => r.type === 'sale')), sua_chua: money(sum(r => r.type === 'repair')),
      tien_mat: money(sum(r => r.payment_method === 'cash')), chuyen_khoan: money(sum(r => r.payment_method === 'transfer')),
      ban_no: money(sum(r => r.payment_method === 'debt')), thu_no: money(debtPaid), chi_phi: money(exp.s), so_khoan_chi: exp.n,
    };
    if (a.chi_tiet) {
      out.giao_dich = db.prepare(`SELECT type, content, customer_name, amount, payment_method, staff_name, created_at FROM revenues WHERE ${D} ORDER BY created_at DESC LIMIT 25`)
        .all(from, to).map(r => ({ loai: r.type === 'sale' ? 'bán hàng' : 'sửa chữa', noi_dung: r.content, khach: r.customer_name, tien: money(r.amount),
          tt: { cash: 'tiền mặt', transfer: 'chuyển khoản', debt: 'nợ' }[r.payment_method], nv: r.staff_name, ngay: vnDay(r.created_at) }));
    }
    return out;
  }
  if (name === 'cong_no') {
    const debts = require('./debts');
    const rows = debts.list({ search: a.tu_khoa || '' }).map(d => ({ ten: d.name || '(không tên)', sdt: d.phone || null, con_no: money(d.balance), so_don: d.orders, gan_nhat: vnDay(d.last) }));
    return { tong_con_no: money(debts.totals().balance), ...cut(rows, 20) };
  }
  return { loi: 'Không có hàm này.' };
}

// ---------- hàm tra cứu: đối tác (chỉ máy của chính đối tác) ----------
const PARTNER_TOOLS = [{
  name: 'may_cua_khach',
  description: 'Tra các máy khách này đã gửi cửa hàng sửa (máy đang ở cửa hàng + máy đã trả trong 90 ngày gần đây).',
  parameters: { type: 'object', properties: {
    tu_khoa: { type: 'string', description: 'tên máy / linh kiện / mã phiếu, VD "b760", "dell 7490". Bỏ trống = tất cả' },
    con_o_cua_hang: { type: 'boolean', description: 'true = chỉ máy chưa trả' },
  } },
}];
const partnerTasks = db.prepare(`SELECT * FROM tasks WHERE partner_id = ? AND (status <> 'completed' OR completed_at >= ?) ORDER BY created_at DESC LIMIT 300`);

function runPartner(partner, name, a) {
  if (name !== 'may_cua_khach') return { loi: 'Không có hàm này.' };
  const ws = terms(a.tu_khoa || '');
  const since = new Date(Date.now() - 90 * 86400e3).toISOString();
  const rows = partnerTasks.all(partner.id, since)
    .filter(t => (!a.con_o_cua_hang || t.status !== 'completed') && hit(ws, flat(`${t.ticket_code} ${t.device_model} ${t.specs || ''} ${t.issue_desc}`)))
    .map(t => taskRow(t, false));
  return cut(rows, 20);
}

// ---------- hội thoại ----------
function ctx(chatId) {
  const h = history.get(chatId);
  if (!h || Date.now() - h.at > HISTORY_TTL) return [];
  return h.turns;
}
function remember(chatId, q1, a1) {
  const turns = [...ctx(chatId), { role: 'user', text: q1 }, { role: 'model', text: a1 }].slice(-HISTORY_TURNS);
  history.set(chatId, { at: Date.now(), turns });
  if (history.size > 300) history.delete(history.keys().next().value);
}

function today() {
  const d = new Date(Date.now() + 7 * 3600e3);
  const dow = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'][d.getUTCDay()];
  return `${dow}, ${d.toISOString().slice(0, 10)} (giờ Việt Nam, ${d.toISOString().slice(11, 16)})`;
}
const STYLE = 'Trả lời bằng tiếng Việt, ngắn gọn, thân thiện, văn bản thuần cho Zalo: KHÔNG dùng markdown (không **, #, bảng), liệt kê bằng dấu "• ". ' +
  'Dưới 1500 ký tự. Số tiền ghi như dữ liệu trả về (VD 1.250.000 ₫).';

async function answer(chatId, text, system, tools, run) {
  let out = await ai.chatWithTools({ system, history: ctx(chatId), text, tools, run });
  // Có con số mà không tra dữ liệu = có thể bịa → hỏi lại, bắt buộc tra
  if (tools.length && !out.used.length && /\d/.test(out.text)) out = await ai.chatWithTools({ system, history: ctx(chatId), text, tools, run, forceTool: true });
  if (!out.text) throw new Error('AI không trả lời');
  remember(chatId, text, out.text);
  return out;
}

async function staffAnswer(user, chatId, text) {
  const shop = settings.get('company_name') || 'Chí Công Computer';
  const isMgr = user.role === 'manager';
  const system = `Bạn là trợ lý nội bộ của cửa hàng máy tính ${shop}, trả lời qua Zalo cho ${isMgr ? 'quản lý' : 'nhân viên'} tên ${user.full_name}. Hôm nay: ${today()}.\n` +
    'Luôn gọi hàm tra cứu để lấy số liệu thật; TUYỆT ĐỐI không bịa giá, số lượng, doanh thu. Không tìm thấy thì nói không có và gợi ý cách hỏi khác ' +
    '(VD thử từ khóa ngắn hơn: "h610" thay vì "main msi h610m pro"). Có thể gọi nhiều hàm / nhiều lần. ' +
    'Khi được nhờ báo giá ráp PC: dùng bao_gia cho từng linh kiện, cộng tổng, ghi rõ món nào kho hết. ' +
    'Bạn chỉ đọc dữ liệu: không thể bán hàng, sửa, xóa hay tạo task — nếu được nhờ thì hướng dẫn làm trên web. ' +
    (isMgr ? '' : 'Người này là nhân viên: không có quyền xem doanh thu, chi phí, công nợ — nếu hỏi thì nói chỉ quản lý xem được. ') + STYLE;
  return answer(chatId, text, system, isMgr ? [...STAFF_TOOLS, ...MANAGER_TOOLS] : STAFF_TOOLS, (n, a) => runStaff(user, n, a));
}

async function partnerAiAnswer(partner, chatId, text) {
  const shop = settings.get('company_name') || 'Chí Công Computer';
  // Danh sách máy của khách này đưa thẳng vào cho AI (ít, không cần gọi hàm → không thể trả lời mà không xem dữ liệu)
  const data = runPartner(partner, 'may_cua_khach', {});
  const system = `Bạn là trợ lý của cửa hàng sửa máy tính ${shop}, trả lời khách/đối tác "${partner.name}" qua Zalo, xưng "${shop}" hoặc "em", gọi khách là "anh/chị". Hôm nay: ${today()}.\n` +
    'Chỉ trả lời về tình trạng các máy khách này gửi sửa, DỰA DUY NHẤT vào DỮ LIỆU bên dưới (máy đang ở cửa hàng + máy đã trả trong 90 ngày). ' +
    'Tìm máy khớp câu hỏi (theo tên máy, linh kiện, lỗi, mã phiếu, ngày nhận). Không bịa tình trạng, chi phí, ngày trả. ' +
    'Không có máy khớp thì nói không tìm thấy và liệt kê ngắn các máy đang ở cửa hàng (nếu có). Khớp nhiều máy thì liệt kê hết các máy khớp. ' +
    'Máy "sửa xong" hoặc "không sửa được" thì mời khách qua nhận. Chi phí chưa chốt thì nói là dự kiến; chi phí trống thì nói cửa hàng sẽ báo sau; chi phí 0 ₫ = không tính phí. ' +
    'Câu hỏi ngoài phạm vi (giá linh kiện, mua hàng, kỹ thuật...) thì mời gọi điện cửa hàng. Không nhắc tới dữ liệu, hệ thống hay AI. ' + STYLE +
    '\n\nDỮ LIỆU (JSON):\n' + JSON.stringify(data);
  return answer(chatId, text, system, [], null);
}

module.exports = { isOn, setOn, staffAnswer, partnerAiAnswer, runStaff, runPartner };

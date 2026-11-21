'use strict';
// AI tra thông số linh kiện: tra 1 món (trả kết quả để người dùng xem lại) và chạy hàng loạt dưới nền (tự lưu)
const db = require('../db');
const ai = require('./aiService');
const pc = require('./pcParts');

async function research(part) {
  return ai.researchPcPart({ name: part.name, category: part.category, condition: part.condition, fields: pc.fieldsOf(part.category) });
}

const save = db.prepare(`UPDATE pc_parts SET specs = @specs, summary = @summary, sources = @sources, ai_at = @ai_at,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`);

// ---- Chạy hàng loạt: các món chưa có thông tin (ai_at trống), lần lượt từng món ----
const state = { running: false, stopRequested: false, done: 0, failed: 0, total: 0, current: null, error: null, finishedAt: null };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quotaErr = e => /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(String(e && (e.status || e.message)));

function pending() { return db.prepare(`SELECT * FROM pc_parts WHERE ai_at IS NULL AND hidden = 0 ORDER BY sort, id`).all(); }

async function runBatch() {
  const list = pending();
  Object.assign(state, { running: true, stopRequested: false, done: 0, failed: 0, total: list.length, current: null, error: null, finishedAt: null });
  try {
    for (const p of list) {
      if (state.stopRequested) { state.error = 'Đã dừng theo yêu cầu.'; break; }
      state.current = pc.displayName(p);
      try {
        const r = await research(p);
        save.run({ id: p.id, specs: JSON.stringify(r.specs), summary: r.summary || null, sources: JSON.stringify(r.sources), ai_at: new Date().toISOString() });
        state.done++;
      } catch (e) {
        if (quotaErr(e)) { state.error = 'Gemini hết lượt miễn phí — đã tạm dừng. Bấm chạy tiếp sau vài giờ (hoặc ngày mai).'; break; }
        state.failed++;
        console.warn('[pc-ai]', p.name, e.message);
      }
      await sleep(4000); // giãn cách để không đụng giới hạn/phút
    }
  } finally {
    state.running = false; state.current = null; state.finishedAt = new Date().toISOString();
  }
}

function start() {
  if (state.running) return false;
  if (!ai.isEnabled()) throw Object.assign(new Error('Chưa cấu hình GEMINI_API_KEY trong file .env'), { status: 400, expose: true });
  runBatch().catch(e => { state.error = e.message; state.running = false; });
  return true;
}
function stop() { state.stopRequested = true; }
function status() { return { ...state, remaining: db.prepare('SELECT COUNT(*) n FROM pc_parts WHERE ai_at IS NULL AND hidden = 0').get().n }; }

module.exports = { research, start, stop, status };

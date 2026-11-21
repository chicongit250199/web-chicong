'use strict';
// Session store dùng chính SQLite (bền qua restart, không rò RAM như MemoryStore)
const { Store } = require('express-session');

class SqliteStore extends Store {
  constructor(db, { ttlMs = 7 * 24 * 3600 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.touched = new Map();
    this.q = {
      get: db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    this.q.prune.run(Date.now());
    setInterval(() => this.q.prune.run(Date.now()), 3600 * 1000).unref();
  }
  expiry(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + this.ttlMs;
  }
  get(sid, cb) {
    try {
      const row = this.q.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { this.q.set.run(sid, JSON.stringify(sess), this.expiry(sess)); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { this.q.destroy.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  // rolling session gọi touch ở MỌI request -> chỉ ghi DB khi đã quá 10 phút từ lần gia hạn trước
  touch(sid, sess, cb) {
    try {
      const exp = this.expiry(sess);
      const last = this.touched.get(sid) || 0;
      if (exp - last > 10 * 60 * 1000) { this.q.touch.run(exp, sid); this.touched.set(sid, exp); }
      if (this.touched.size > 5000) this.touched.clear();
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
}

module.exports = SqliteStore;

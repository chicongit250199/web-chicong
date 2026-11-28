// Liên kết Zalo: tài khoản nhân viên (base '/manager/users') và nhóm Zalo đối tác (base '/staff/partners')
window.zaloLink = function (base, extra) {
  return Object.assign({
    m: null, u: {}, zs: {}, zerr: '', zmsg: '', code: '', linked: false, linkedName: '', timer: null, busy: false, overdueAt: '',
    init: function () { this.loadStatus(); },
    loadStatus: function () {
      var self = this;
      api('/manager/users/zalo/status').then(function (d) { self.zs = d; if (!self.overdueAt) self.overdueAt = d.overdueAt; }).catch(function (e) { self.zerr = e.message; });
    },
    startLink: function (item) {
      var self = this;
      this.u = item; this.m = 'zalo'; this.code = ''; this.linked = false; this.zerr = '';
      api(base + '/' + item.id + '/zalo/code', { method: 'POST' }).then(function (d) {
        self.code = d.code;
        self.timer = setInterval(function () { self.check(); }, 3000);
      }).catch(function (e) { self.zerr = e.message; });
    },
    check: function () {
      var self = this;
      api(base + '/' + this.u.id + '/zalo').then(function (d) {
        if (d && d.linked) { self.linked = true; self.linkedName = d.name; self.stop(); }
      }).catch(function () {});
    },
    stop: function () { if (this.timer) { clearInterval(this.timer); this.timer = null; } },
    closeModal: function () {
      var reload = this.m === 'zalo' && this.linked;
      this.stop(); this.m = null;
      if (reload) location.reload();
    },
    setEnabled: function (id, on) {
      var self = this;
      api(base + '/' + id + '/zalo/enabled', { method: 'POST', body: { enabled: on } }).then(function () { location.reload(); }).catch(function (e) { self.zerr = e.message; });
    },
    unlink: function (id, name) {
      var self = this;
      uiConfirm('Gỡ liên kết Zalo của ' + name + '? Sẽ không nhận thông báo Zalo nữa.', { ok: 'Gỡ liên kết', tone: 'danger' }).then(function (ok) {
        if (!ok) return;
        api(base + '/' + id + '/zalo/unlink', { method: 'POST' }).then(function () { location.reload(); }).catch(function (e) { self.zerr = e.message; });
      });
    },
    test: function (id) {
      var self = this; this.zerr = ''; this.zmsg = '';
      api(base + '/' + id + '/zalo/test', { method: 'POST' }).then(function () { self.zmsg = 'Đã gửi tin thử.'; self.loadStatus(); })
        .catch(function (e) { self.zerr = e.message; self.loadStatus(); });
    },
    saveOverdueAt: function () {
      var self = this; this.busy = true; this.zerr = ''; this.zmsg = '';
      api('/manager/users/zalo/overdue-at', { method: 'POST', body: { at: this.overdueAt } }).then(function (d) { self.zs = d; self.zmsg = 'Đã lưu giờ nhắc.'; })
        .catch(function (e) { self.zerr = e.message; }).finally(function () { self.busy = false; });
    },
    setAi: function (on) {
      var self = this; this.busy = true; this.zerr = ''; this.zmsg = '';
      api('/manager/users/zalo/ai', { method: 'POST', body: { on: on } }).then(function (d) { self.zs = d; self.zmsg = on ? 'Đã bật trả lời bằng AI.' : 'Đã tắt trả lời bằng AI.'; })
        .catch(function (e) { self.zerr = e.message; self.loadStatus(); }).finally(function () { self.busy = false; });
    },
    overdueNow: function () {
      var self = this; this.busy = true; this.zerr = ''; this.zmsg = '';
      api('/manager/users/zalo/overdue-now', { method: 'POST' }).then(function (d) { self.zs = d; self.zmsg = d.people ? 'Đã gửi nhắc cho ' + d.people + ' người.' : 'Không ai có task quá hạn.'; })
        .catch(function (e) { self.zerr = e.message; }).finally(function () { self.busy = false; });
    },
  }, extra || {});
};

// Nhật ký Zalo (Hệ thống → Nhân viên - Zalo): tin người nhắn + bot trả lời, tin bot tự gửi
window.zaloLog = function () {
  var KIND = { notify: ['Thông báo', 'badge-blue'], partner: ['Gửi nhóm đối tác', 'badge-green'], overdue: ['Nhắc quá hạn', 'badge-amber'], test: ['Tin thử', 'badge-gray'], reply: ['Trả lời', 'badge-gray'] };
  return {
    items: [], more: false, loading: false, err: '', type: 'all', q: '', seq: 0,
    init: function () { this.load(); },
    load: function (append) {
      var self = this, n = ++this.seq;
      var url = '/manager/users/zalo/log?limit=50&type=' + this.type + '&q=' + encodeURIComponent(this.q || '');
      if (append && this.items.length) url += '&before=' + this.items[this.items.length - 1].id;
      this.loading = true; this.err = '';
      api(url).then(function (d) {
        if (n !== self.seq) return; // đã có lần tải mới hơn (gõ tìm nhanh)
        self.items = append ? self.items.concat(d.items) : d.items;
        self.more = d.more;
      }).catch(function (e) { if (n === self.seq) self.err = e.message; })
        .finally(function () { if (n === self.seq) self.loading = false; });
    },
    kindLabel: function (r) { return r.dir === 'in' ? (r.is_group ? 'Nhóm' : 'Nhắn riêng') : (KIND[r.kind] || [r.kind])[0]; },
    kindBadge: function (r) { return r.dir === 'in' ? 'badge-violet' : (KIND[r.kind] || [0, 'badge-gray'])[1]; },
    when: function (iso) { return iso ? new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : ''; },
  };
};

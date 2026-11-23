// Liên kết Zalo: tài khoản nhân viên (base '/manager/users') và nhóm Zalo đối tác (base '/staff/partners')
window.zaloLink = function (base, extra) {
  return Object.assign({
    m: null, u: {}, zs: {}, zerr: '', zmsg: '', code: '', linked: false, linkedName: '', timer: null, busy: false, sendTo: '', sendText: '',
    init: function () { this.loadStatus(); },
    loadStatus: function () {
      var self = this;
      api('/manager/users/zalo/status').then(function (d) { self.zs = d; }).catch(function (e) { self.zerr = e.message; });
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
    sendCustom: function () {
      var self = this; this.busy = true; this.zerr = ''; this.zmsg = '';
      api('/manager/users/zalo/send', { method: 'POST', body: { target: this.sendTo, text: this.sendText } })
        .then(function (d) { self.zmsg = 'Đã gửi tới ' + d.to + '.'; self.sendText = ''; self.loadStatus(); })
        .catch(function (e) { self.zerr = e.message; self.loadStatus(); }).finally(function () { self.busy = false; });
    },
  }, extra || {});
};

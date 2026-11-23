// Trang Tài khoản nhân viên: liên kết / bật tắt thông báo Zalo
window.zaloUsers = function () {
  return {
    m: null, u: {}, zs: {}, zerr: '', zmsg: '', code: '', linked: false, linkedName: '', timer: null,
    init: function () { this.loadStatus(); },
    loadStatus: function () { var self = this; api('/manager/users/zalo/status').then(function (d) { self.zs = d; }).catch(function (e) { self.zerr = e.message; }); },
    startLink: function (user) {
      var self = this;
      this.u = user; this.m = 'zalo'; this.code = ''; this.linked = false; this.zerr = '';
      api('/manager/users/' + user.id + '/zalo/code', { method: 'POST' }).then(function (d) {
        self.code = d.code;
        self.timer = setInterval(function () { self.check(); }, 3000);
      }).catch(function (e) { self.zerr = e.message; });
    },
    check: function () {
      var self = this;
      api('/manager/users/' + this.u.id + '/zalo').then(function (d) {
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
      api('/manager/users/' + id + '/zalo/enabled', { method: 'POST', body: { enabled: on } }).then(function () { location.reload(); }).catch(function (e) { self.zerr = e.message; });
    },
    unlink: function (id, name) {
      var self = this;
      uiConfirm('Gỡ liên kết Zalo của ' + name + '? Người này sẽ không nhận thông báo Zalo nữa.', { ok: 'Gỡ liên kết', tone: 'danger' }).then(function (ok) {
        if (!ok) return;
        api('/manager/users/' + id + '/zalo/unlink', { method: 'POST' }).then(function () { location.reload(); }).catch(function (e) { self.zerr = e.message; });
      });
    },
    test: function (id) {
      var self = this; this.zerr = ''; this.zmsg = '';
      api('/manager/users/' + id + '/zalo/test', { method: 'POST' }).then(function () { self.zmsg = 'Đã gửi tin thử.'; self.loadStatus(); })
        .catch(function (e) { self.zerr = e.message; self.loadStatus(); });
    },
  };
};

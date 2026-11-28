// Chọn báo cáo "Kiểm tra cấu hình máy" (script /shel gửi lên). mode 'intake': điền vào form Nhận máy; 'task': gắn vào task đang xem
window.pcPick = function (mode, taskId) {
  return {
    open: false, items: [], loading: false, err: '', chosen: null, timer: null, busy: false,
    show: function () { this.open = true; this.load(); var self = this; clearInterval(this.timer); this.timer = setInterval(function () { if (self.open) self.load(true); else clearInterval(self.timer); }, 5000); },
    hide: function () { this.open = false; clearInterval(this.timer); },
    load: function (quiet) {
      var self = this;
      if (!quiet) self.loading = true;
      api('/staff/pc-reports.json').then(function (d) { self.items = d.items; self.err = ''; })
        .catch(function (e) { self.err = e.message; }).finally(function () { self.loading = false; });
    },
    ago: function (s) {
      var m = Math.round((Date.now() - new Date(s)) / 60000);
      return m < 1 ? 'vừa xong' : m < 60 ? m + ' phút trước' : Math.floor(m / 60) + ' giờ trước';
    },
    pick: function (r) {
      var self = this;
      if (mode === 'task') {
        self.busy = true;
        api('/staff/tasks/' + taskId + '/pc-report', { method: 'POST', body: { report_id: r.id } })
          .then(function () { location.reload(); })
          .catch(function (e) { self.err = e.message; self.busy = false; });
        return;
      }
      var form = self.$root;
      var model = form.querySelector('[name=device_model]'), specs = form.querySelector('[name=specs]');
      var apply = function () {
        if (r.model) model.value = r.model;
        specs.value = r.summary;
        specs.rows = Math.min(8, r.summary.split('\n').length);
        form.querySelector('[name=pc_report_id]').value = r.id;
        self.chosen = r;
        self.hide();
      };
      var busyFields = (model.value.trim() && model.value.trim() !== r.model) || (specs.value.trim() && specs.value.trim() !== r.summary);
      if (busyFields) uiConfirm('Thay Model / Cấu hình đang nhập bằng thông tin của máy này?', { tone: 'warning', ok: 'Thay' }).then(function (ok) { if (ok) apply(); });
      else apply();
    },
    unpick: function () { this.chosen = null; this.$root.querySelector('[name=pc_report_id]').value = ''; },
  };
};

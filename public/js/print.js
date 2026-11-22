// Trang In tài liệu (nhân viên)
window.printPage = function () {
  var data = JSON.parse(document.getElementById('print-data').textContent);
  var def = (data.printers.filter(function (p) { return p.isDefault; })[0] || data.printers[0] || {}).name || '';
  var OK = /\.(pdf|jpe?g|png|txt)$/i;
  return {
    s: data, printer: def, files: [], copies: 1, fit: true, busy: false, drag: false, err: '', results: [], timer: null,
    init: function () { this.poll(); },
    // hàng đợi tự cập nhật khi đang có lệnh in
    poll: function () {
      var self = this; clearTimeout(this.timer);
      this.timer = setTimeout(function () {
        if (document.hidden || !(self.s.jobs && self.s.jobs.length)) return self.poll();
        api('/staff/print/status').then(function (d) { self.s = d; }).catch(function () {}).finally(function () { self.poll(); });
      }, 4000);
    },
    ext: function (f) { var m = f.name.match(/\.(\w+)$/); return m ? m[1].toUpperCase() : '?'; },
    add: function (list) {
      this.err = '';
      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        if (!OK.test(f.name)) { this.err = 'Bỏ qua "' + f.name + '": chỉ in được PDF, JPG, PNG, TXT.'; continue; }
        if (f.size > 30 * 1048576) { this.err = 'Bỏ qua "' + f.name + '": file quá 30 MB.'; continue; }
        if (this.files.length >= 10) { this.err = 'Tối đa 10 file mỗi lần.'; break; }
        this.files.push(f);
      }
    },
    send: function () {
      var self = this; this.busy = true; this.err = ''; this.results = [];
      var fd = new FormData();
      fd.append('printer', this.printer); fd.append('copies', this.copies); fd.append('fit', this.fit ? '1' : '0');
      this.files.forEach(function (f) { fd.append('files', f); });
      api('/staff/print', { method: 'POST', body: fd }).then(function (d) {
        self.results = d.results; self.s = d;
        self.files = self.files.filter(function (f) { return d.results.some(function (r) { return !r.ok && r.file === f.name; }); });
      }).catch(function (e) { self.err = e.message; }).finally(function () { self.busy = false; });
    },
    cancel: function (j) {
      var self = this;
      uiConfirm('Hủy lệnh in "' + (j.title || j.id) + '"?', { ok: 'Hủy lệnh in', cancel: 'Không' }).then(function (ok) {
        if (!ok) return;
        api('/staff/print/jobs/' + encodeURIComponent(j.id) + '/cancel', { method: 'POST' }).then(function (d) { self.s = d; }).catch(function (e) { self.err = e.message; });
      });
    },
  };
};

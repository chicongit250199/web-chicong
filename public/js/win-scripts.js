// Hệ thống → Script Windows: danh sách / thêm / sửa / cập nhật từ gist các script của link /shel
window.winScripts = function (slug) {
  var BASE = '/manager/system/scripts';
  return {
    items: [], loaded: false, busy: '', msg: '', err: '', slug: slug || 'shel', slugEdit: slug || 'shel',
    ed: null, edErr: '', gistBusy: false, dirty: false,

    init: function () { this.load(); },
    load: function () {
      var self = this;
      api(BASE + '.json').then(function (d) { self.items = d.items; self.loaded = true; }).catch(function (e) { self.err = e.message; });
    },
    // Gọi API thay đổi; d.items = danh sách mới
    run: function (key, url, body, okMsg) {
      var self = this;
      self.busy = key; self.err = ''; self.msg = '';
      return api(url, { method: 'POST', body: body || {} }).then(function (d) {
        if (d.items) self.items = d.items;
        if (okMsg) self.msg = typeof okMsg === 'function' ? okMsg(d) : okMsg;
        return d;
      }).catch(function (e) { self.err = e.message; throw e; }).finally(function () { self.busy = ''; });
    },

    menuNo: function (s) { return this.items.filter(function (x) { return x.enabled; }).indexOf(s) + 1; },
    kb: function (n) { n = n || 0; return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; },
    bytes: function (s) { return new Blob([s || '']).size; },
    lines: function (s) { return s ? s.split('\n').length : 0; },
    dt: function (s) { return s ? new Date(s).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }) : ''; },
    copy: function (t) {
      var self = this;
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { self.msg = 'Đã chép: ' + t; })
        .catch(function () { window.prompt('Chép lệnh này:', t); });
    },

    saveSlug: function () {
      var self = this;
      self.run('slug', BASE + '/slug', { slug: self.slugEdit }, function (d) { return 'Đã đổi link: chicongcomputer.local/' + d.slug; })
        .then(function (d) { self.slug = d.slug; self.slugEdit = d.slug; }).catch(function () {});
    },
    toggle: function (s, on) { this.run(s.id, BASE + '/' + s.id, { enabled: on }, (on ? 'Đã bật ' : 'Đã tắt ') + s.name).catch(this.load.bind(this)); },
    togglePe: function (s, on) { this.run(s.id, BASE + '/' + s.id, { pe: on }, s.name + (on ? ': hiện trên WinPE' : ': ẩn trên WinPE')).catch(this.load.bind(this)); },
    move: function (s, dir) { this.run(s.id, BASE + '/' + s.id + '/move', { dir: dir }).catch(function () {}); },
    sync: function (s) {
      this.run(s.id, BASE + '/' + s.id + '/sync', {}, function (d) {
        return d.result.changed ? 'Đã cập nhật ' + s.name + ' từ gist (' + d.result.file + ')' : s.name + ': bản trên gist giống bản đang dùng — không đổi';
      }).catch(function () {});
    },
    syncAll: function () {
      this.run('all', BASE + '/sync-all', {}, function (d) {
        var bad = d.results.filter(function (r) { return !r.ok; });
        var changed = d.results.filter(function (r) { return r.ok && r.changed; }).map(function (r) { return r.name; });
        return (changed.length ? 'Đã cập nhật: ' + changed.join(', ') : 'Tất cả script đã là bản mới nhất')
          + (bad.length ? '\nLỗi: ' + bad.map(function (r) { return r.name + ' — ' + r.error; }).join('\n') : '');
      }).catch(function () {});
    },
    undo: function (s) {
      var self = this;
      uiConfirm('Khôi phục ' + s.name + ' về bản trước lần sửa / cập nhật gần nhất?', { tone: 'warning', ok: 'Khôi phục' }).then(function (ok) {
        if (ok) self.run(s.id, BASE + '/' + s.id + '/undo', {}, 'Đã khôi phục bản trước của ' + s.name).catch(function () {});
      });
    },
    del: function (s) {
      var self = this;
      uiConfirm('Xóa script "' + s.name + '" (' + s.file + ')? Menu trên máy khách sẽ không còn mục này.', { tone: 'danger' }).then(function (ok) {
        if (ok) self.run(s.id, BASE + '/' + s.id + '/delete', {}, 'Đã xóa ' + s.name).catch(function () {});
      });
    },

    // ---- Thêm / sửa ----
    openNew: function () { this.edErr = ''; this.ed = { id: null, name: '', file: '', descr: '', gist_url: '', content: '', enabled: true, pe: false }; this.watch(); },
    openEdit: function (s) {
      var self = this;
      self.edErr = '';
      api(BASE + '/' + s.id + '/content').then(function (d) {
        var it = d.item;
        self.ed = { id: it.id, name: it.name, file: it.file, descr: it.descr, gist_url: it.gist_url || '', content: it.content, enabled: !!it.enabled, pe: !!it.pe };
        self.watch();
      }).catch(function (e) { self.err = e.message; });
    },
    watch: function () { var self = this; self.dirty = false; self.$nextTick(function () { self.$watch('ed', function () { self.dirty = true; }, { deep: true }); }); },
    close: function () {
      var self = this;
      if (!self.dirty) { self.ed = null; return; }
      uiConfirm('Bỏ các thay đổi chưa lưu?', { tone: 'warning', ok: 'Bỏ' }).then(function (ok) { if (ok) self.ed = null; });
    },
    fromGist: function () {
      var self = this, ed = self.ed;
      var go = function () {
        self.gistBusy = true; self.edErr = '';
        api(BASE + '/gist', { method: 'POST', body: { url: ed.gist_url, file: ed.file } }).then(function (g) {
          ed.content = g.content;
          if (!ed.file) ed.file = g.file;
          if (!ed.name && g.description) ed.name = g.description;
          if (g.files.length > 1) self.edErr = 'Gist có ' + g.files.length + ' file, đã lấy ' + g.file + ' (muốn file khác thì sửa ô Tên file cho trùng rồi bấm lấy lại).';
        }).catch(function (e) { self.edErr = e.message; }).finally(function () { self.gistBusy = false; });
      };
      if (ed.content.trim()) uiConfirm('Thay nội dung đang có bằng bản trên gist?', { tone: 'warning', ok: 'Thay' }).then(function (ok) { if (ok) go(); });
      else go();
    },
    loadFile: function (ev) {
      var self = this, f = ev.target.files[0];
      ev.target.value = '';
      if (!f) return;
      if (f.size > 1024 * 1024) { self.edErr = 'File quá lớn (tối đa 1 MB)'; return; }
      var rd = new FileReader();
      rd.onload = function () {
        self.ed.content = String(rd.result).replace(/^﻿/, '');
        if (!self.ed.file) self.ed.file = f.name;
      };
      rd.readAsText(f, 'utf-8');
    },
    save: function () {
      var self = this, ed = self.ed;
      self.edErr = '';
      var url = ed.id ? BASE + '/' + ed.id : BASE;
      self.run('save', url, { name: ed.name, file: ed.file, descr: ed.descr, gist_url: ed.gist_url, content: ed.content, enabled: ed.enabled, pe: ed.pe },
        (ed.id ? 'Đã lưu ' : 'Đã thêm ') + ed.name + ' — menu trên máy khách đã đổi')
        .then(function () { self.ed = null; })
        .catch(function (e) { self.err = ''; self.edErr = e.message; });
    },
  };
};

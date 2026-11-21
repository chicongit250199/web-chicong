// AI cho form sản phẩm (Đăng sản phẩm + Sửa sản phẩm): đọc / ghi thẳng vào các ô name_vi, specs_vi, desc_vi
window.productAi = function () {
  return {
    busy: '', err: '', sources: [], took: 0,
    f: function (name) { return (this.$root.closest('form') || this.$root).querySelector('[name="' + name + '"]'); },
    val: function (name) { var el = this.f(name); return el ? el.value : ''; },
    set: function (name, v) {
      var el = this.f(name); if (!el) return;
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true })); // để x-model (nếu có) nhận giá trị mới
    },
    // Tra cứu thông số thật trên Google + viết bài chi tiết
    research: function () {
      var self = this;
      var name = this.val('name_vi').trim();
      if (name.length < 3) { this.err = 'Nhập tên / model máy trước (VD: Dell Latitude 5420).'; return; }
      if ((this.val('desc_vi').trim() || '') && !confirm('Thay mô tả hiện có bằng bài AI viết? (Cấu hình đã nhập sẽ được giữ làm gợi ý cho AI.)')) return;
      this.err = ''; this.sources = []; this.busy = 'research';
      var t0 = Date.now();
      api('/staff/api/ai/research', { method: 'POST', body: {
        name: name, specs: this.val('specs_vi'), category_id: this.val('category_id'), price: this.val('price'),
      } }).then(function (d) {
        if (d.specs) self.set('specs_vi', d.specs);
        if (d.description) self.set('desc_vi', d.description);
        self.sources = d.sources || [];
        self.took = Math.round((Date.now() - t0) / 1000);
      }).catch(function (e) { self.err = e.message; })
        .finally(function () { self.busy = ''; });
    },
    // Viết nhanh chỉ từ tên + cấu hình đã nhập (không tra cứu)
    quick: function () {
      var self = this;
      var name = this.val('name_vi').trim();
      if (!name) { this.err = 'Nhập tên sản phẩm trước.'; return; }
      this.err = ''; this.busy = 'quick';
      api('/staff/api/ai/describe', { method: 'POST', body: {
        name: name, specs: this.val('specs_vi'), category_id: this.val('category_id'), price: this.val('price'),
      } }).then(function (d) { self.set('desc_vi', d.description); })
        .catch(function (e) { self.err = e.message; })
        .finally(function () { self.busy = ''; });
    },
  };
};

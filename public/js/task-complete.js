// Form "Hoàn thành — trả máy": tiền sửa máy + bán kèm hàng / dịch vụ (trừ kho như trang Bán hàng)
window.completeForm = function (repairAmount) {
  return {
    amount: String(repairAmount || 0),
    // ô nhập món bán kèm
    q: '', results: [], open: false, loading: false, hi: -1, timer: null,
    group: null, unitId: '', price: '', warranty: '', kind: 'sale', error: '',
    cart: [], // { item_id, name, serial, kind, price, warranty, warrantyShow }

    get amountDisplay() { return this.amount === '' ? '' : formatVnd(this.amount); },
    onAmount: function (e) { this.amount = e.target.value.replace(/\D/g, ''); e.target.value = this.amountDisplay; },
    get extraSum() { return this.cart.reduce(function (s, l) { return s + Number(l.price || 0); }, 0); },
    get total() { return Number(this.amount || 0) + this.extraSum; },
    get extraJson() {
      return JSON.stringify(this.cart.map(function (l) { return { item_id: l.item_id, name: l.item_id ? '' : l.name, kind: l.kind, price: l.price, warranty_months: l.warranty }; }));
    },

    get inCart() { return this.cart.filter(function (l) { return l.item_id; }).map(function (l) { return l.item_id; }); },
    get freeUnits() { var ids = this.inCart; return this.group ? this.group.units.filter(function (u) { return ids.indexOf(u.id) < 0; }) : []; },
    get hasSerials() { return this.group && this.group.units.some(function (u) { return u.serial; }); },
    get free() { return !this.group && this.q.trim().length > 0; },
    get unit() {
      if (!this.group) return null;
      var id = Number(this.unitId);
      return this.group.units.find(function (u) { return u.id === id; }) || null;
    },
    get priceDisplay() { return this.price === '' ? '' : formatVnd(this.price); },
    onPrice: function (e) { this.price = e.target.value.replace(/\D/g, ''); e.target.value = this.priceDisplay; },

    search: function () {
      var self = this;
      clearTimeout(this.timer);
      this.group = null; this.unitId = '';
      if (!this.q.trim()) { this.results = []; this.open = false; return; }
      this.timer = setTimeout(function () {
        self.loading = true;
        api('/staff/api/inventory/suggest?q=' + encodeURIComponent(self.q.trim()))
          .then(function (d) { self.results = d.items; self.open = true; self.hi = d.items.length ? 0 : -1; })
          .catch(function (e) { self.error = e.message; })
          .finally(function () { self.loading = false; });
      }, 200);
    },
    move: function (d) { if (this.results.length) this.hi = (this.hi + d + this.results.length) % this.results.length; },
    choose: function (g) {
      g = g || this.results[this.hi];
      if (!g) return;
      var term = this.q.trim().toLowerCase();
      this.group = g; this.q = g.name; this.open = false; this.error = '';
      var units = this.freeUnits;
      if (!units.length) { this.error = 'Đã thêm hết số lượng còn trong kho của món này.'; this.group = null; return; }
      var match = units.find(function (u) { return u.serial && u.serial.toLowerCase() === term; });
      var first = match || (this.hasSerials ? null : units[0]);
      this.unitId = first ? String(first.id) : (units.length === 1 ? String(units[0].id) : '');
      this.applyUnit();
    },
    applyUnit: function () {
      var u = this.unit;
      var p = (u && u.retail_price != null) ? u.retail_price : this.group && this.group.retail_price;
      this.price = p != null ? String(p) : '';
      var w = (u && u.warranty_out_months != null) ? u.warranty_out_months : this.group && this.group.warranty_out_months;
      this.warranty = w != null ? String(w) : '';
    },
    addLine: function () {
      this.error = '';
      if (this.group && !this.unit) { this.error = 'Chọn số Serial của món hàng.'; return false; }
      if (!this.group && !this.q.trim()) { this.error = 'Nhập tên hàng hóa / dịch vụ.'; return false; }
      if (this.price === '') { this.error = 'Nhập giá tiền món bán kèm.'; return false; }
      var u = this.unit;
      var w = this.warranty !== '' ? this.warranty : (u && u.warranty_out_months != null ? String(u.warranty_out_months) : '');
      this.cart.push({
        item_id: u ? u.id : null, name: this.group ? this.group.name : this.q.trim(), serial: u ? u.serial : null,
        kind: this.group ? 'sale' : this.kind, price: this.price, warranty: this.warranty, warrantyShow: w === '' ? 0 : Number(w),
      });
      this.q = ''; this.results = []; this.group = null; this.unitId = ''; this.price = ''; this.warranty = ''; this.open = false;
      if (this.$refs.q) this.$refs.q.focus();
      return true;
    },
    removeLine: function (i) { this.cart.splice(i, 1); },
    // Đang nhập dở 1 món -> tự thêm vào trước khi gửi
    beforeSubmit: function (e) {
      if (this.q.trim() || this.group) { if (!this.addLine()) { e.preventDefault(); return; } }
      var self = this;
      // cập nhật input ẩn ngay (Alpine chưa kịp render lại trước khi form gửi)
      e.target.querySelector('input[name=extra_items]').value = self.extraJson;
    },
  };
};

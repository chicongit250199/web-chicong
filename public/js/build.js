// Build PC: chọn linh kiện theo nhóm từ báo giá, nhãn Có sẵn / Hàng đặt, kiểm tra tương thích, lưu / in / chốt bán
(function () {
  function vn(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase(); }
  function num(s) { var m = String(s == null ? '' : s).replace(/[.,](?=\d{3}\b)/g, '').match(/\d+(\.\d+)?/); return m ? Number(m[0]) : null; }
  // gộp 2 object giữ nguyên getter (Object.assign làm mất getter)
  function merge(a, b) { var o = {}; Object.defineProperties(o, Object.getOwnPropertyDescriptors(a)); Object.defineProperties(o, Object.getOwnPropertyDescriptors(b)); return o; }
  var SINGLE = { cpu: 1, main: 1, vga: 1, psu: 1, case: 1, cooler: 1 }; // nhóm chỉ chọn 1 món: chọn món khác = thay
  var uid = 0;

  window.buildPc = function () {
    var P = JSON.parse(document.getElementById('build-data').textContent);
    var byId = {};
    P.parts.forEach(function (p) { byId[p.id] = p; });
    var b = P.build;

    function toLine(it, refresh) {
      var p = it.part_id ? byId[it.part_id] : null;
      var l = { uid: ++uid, part_id: p ? p.id : null, category: it.category || (p && p.category) || '', name: it.name, condition: it.condition || '',
        price: String(it.price || 0), qty: it.qty || 1, warranty_months: it.warranty_months, note: it.note || '' };
      if (p && refresh) { l.name = p.name; l.condition = p.condition || ''; l.price = String(p.price || 0); l.warranty_months = p.warranty_months; l.note = p.note_public || ''; }
      return l;
    }

    return merge(window.receiveStock(), {
      parts: P.parts, cats: P.cats, templates: P.templates,
      id: b.id, code: b.code, name: b.name || '', customer_name: b.customer_name || '', customer_phone: b.customer_phone || '',
      customer_addr: b.customer_addr || '', note: b.note || '', is_template: !!b.is_template, soldAt: b.sold_at || null,
      discount: String(b.discount || 0), deposit: String(b.deposit || 0),
      lines: (b.items || []).map(function (it) { return toLine(it, b.refreshPrices); }),
      onlyStock: false, pick: null, q: '', hi: 0,
      saving: false, msg: '', err: '', dirty: false,

      init: function () {
        var self = this;
        this.$watch('lines', function () { self.dirty = true; }, { deep: true });
        ['name', 'customer_name', 'customer_phone', 'customer_addr', 'note', 'discount', 'deposit', 'is_template'].forEach(function (k) { self.$watch(k, function () { self.dirty = true; }); });
        window.addEventListener('beforeunload', function (e) { if (self.dirty && self.lines.length) { e.preventDefault(); e.returnValue = ''; } });
      },

      // ---- danh sách chọn ----
      part: function (l) { return l.part_id ? byId[l.part_id] : null; },
      linesOf: function (cat) { return this.lines.filter(function (l) { return l.part_id && l.category === cat; }); },
      get customLines() { return this.lines.filter(function (l) { return !l.part_id; }); },
      options: function (cat) {
        var q = vn(this.q).trim(); var only = this.onlyStock;
        return this.parts.filter(function (p) {
          return p.category === cat && (!only || p.stock > 0) && (!q || vn(p.name + ' ' + (p.condition || '')).indexOf(q) >= 0);
        });
      },
      openPick: function (cat) { this.pick = this.pick === cat ? null : cat; this.q = ''; this.hi = 0; var self = this; this.$nextTick(function () { var i = document.getElementById('pick-q'); if (i) i.focus(); }); },
      choose: function (p) {
        if (!p) return;
        if (p.price == null) { alert('Món này chưa có giá trong báo giá.'); return; }
        var line = toLine({ part_id: p.id, qty: 1 }, true);
        if (SINGLE[p.type]) {
          var i = this.lines.findIndex(function (l) { return l.part_id && l.category === p.category; });
          if (i >= 0) { this.lines.splice(i, 1, line); this.pick = null; return; }
        }
        var same = this.lines.find(function (l) { return l.part_id === p.id; });
        if (same) same.qty++; else this.lines.push(line);
        this.pick = null;
      },
      pickKey: function (e, cat) {
        var list = this.options(cat);
        if (e.key === 'ArrowDown') { e.preventDefault(); this.hi = Math.min(this.hi + 1, list.length - 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.hi = Math.max(this.hi - 1, 0); }
        else if (e.key === 'Enter') { e.preventDefault(); this.choose(list[this.hi]); }
        else if (e.key === 'Escape') { this.pick = null; }
      },
      remove: function (l) { this.lines = this.lines.filter(function (x) { return x !== l; }); },
      addCustom: function (name, price) { this.lines.push({ uid: ++uid, part_id: null, category: 'Khác', name: name || '', condition: '', price: String(price || 0), qty: 1, warranty_months: null, note: '' }); },
      setMoney: function (obj, key, e) { obj[key] = e.target.value.replace(/\D/g, '') || '0'; e.target.value = formatVnd(obj[key]); },
      applyTemplate: function (t) {
        if (this.lines.length && !confirm('Thay các linh kiện đang chọn bằng cấu hình mẫu "' + t.name + '"?')) return;
        this.lines = t.items.map(function (it) { return toLine(it, true); });
        if (!this.name) this.name = t.name;
      },

      // ---- nhãn kho ----
      stockBadge: function (l) {
        var p = this.part(l);
        if (!p) return null;
        if (p.stock >= l.qty) return { cls: 'badge-green', text: 'Có sẵn ' + p.stock, ok: true };
        if (p.stock > 0) return { cls: 'badge-amber', text: 'Có sẵn ' + p.stock + '/' + l.qty, ok: false };
        return { cls: 'badge-amber', text: 'Hàng đặt', ok: false };
      },
      receive: function (l) {
        var p = this.part(l);
        if (!p) return;
        this.openReceive(p, function (stock) { p.stock = stock; });
      },
      get orderCount() { var self = this; return this.lines.filter(function (l) { var s = self.stockBadge(l); return s && !s.ok; }).length; },

      // ---- tiền ----
      get subtotal() { return this.lines.reduce(function (s, l) { return s + Number(l.price || 0) * Number(l.qty || 1); }, 0); },
      get total() { return Math.max(0, this.subtotal - Number(this.discount || 0)); },
      get remaining() { return Math.max(0, this.total - Number(this.deposit || 0)); },

      // ---- tương thích (dựa trên thông số AI / tên linh kiện) ----
      first: function (type) { var self = this; var l = this.lines.find(function (x) { var p = self.part(x); return p && p.type === type; }); return l ? this.part(l) : null; },
      get warnings() {
        var w = [];
        var cpu = this.first('cpu'), main = this.first('main'), vga = this.first('vga'), psu = this.first('psu'), kase = this.first('case');
        var self = this;
        var rams = this.lines.map(function (l) { return self.part(l); }).filter(function (p) { return p && p.type === 'ram'; });
        var sock = function (p) { var s = p && p.specs.socket; return s ? String(s).toUpperCase().replace(/[\s-]/g, '') : null; };
        var ddr = function (p, field) {
          var s = ((p.specs && p.specs[field]) || '') + ' ' + p.name;
          var m = s.match(/DDR\s?([345])/i) || p.name.match(/\bD([45])\b/i);
          return m ? 'DDR' + m[1] : null;
        };
        if (cpu && main && sock(cpu) && sock(main) && sock(cpu) !== sock(main)) w.push({ bad: true, text: 'CPU socket ' + cpu.specs.socket + ' không lắp được Main socket ' + main.specs.socket + '.' });
        if (main) {
          var md = ddr(main, 'ram_type');
          rams.forEach(function (r) { var rd = ddr(r, 'ram_type'); if (md && rd && md !== rd) w.push({ bad: true, text: r.name + ' là ' + rd + ', Main dùng ' + md + '.' }); });
        }
        rams.forEach(function (r) { if (/laptop|sodimm/i.test((r.specs.form || '') + ' ' + r.name)) w.push({ bad: true, text: r.name + ' là RAM laptop, không dùng cho PC.' }); });
        var noIgpu = cpu && (/^kh[oô]ng|^no/i.test(String(cpu.specs.igpu || '').trim()) || /\d{4,5}K?F\b/i.test(cpu.name));
        if (noIgpu && !vga) w.push({ bad: true, text: 'CPU không có GPU tích hợp (dòng F) — cần chọn thêm VGA.' });
        if (main && kase) {
          var ff = function (s) { s = String(s || '').toUpperCase(); return /E-?ATX/.test(s) ? 'EATX' : /ITX/.test(s) ? 'ITX' : /M-?ATX|MATX|MICRO/.test(s) ? 'MATX' : /ATX/.test(s) ? 'ATX' : null; };
          var mf = ff(main.specs.form_factor) || ff(main.name.match(/\b(M-?ATX|E-?ATX|ITX|ATX)\b/i) && main.name.match(/\b(M-?ATX|E-?ATX|ITX|ATX)\b/i)[0]);
          var cs = String((kase.specs.form_factors || '') + ' ' + kase.name).toUpperCase();
          var plain = cs.replace(/E-?ATX|MICRO[\s-]?ATX|M-?ATX|MINI[\s-]?ITX/g, ' '); // bỏ các chuẩn nhỏ/lớn để dò chữ "ATX" đứng riêng
          var caseMax = /E-?ATX/.test(cs) ? 'EATX' : /\bATX\b/.test(plain) ? 'ATX' : /M-?ATX|MICRO/.test(cs) ? 'MATX' : /ITX/.test(cs) ? 'ITX' : null;
          var rank = { ITX: 1, MATX: 2, ATX: 3, EATX: 4 };
          if (mf && caseMax && rank[mf] > rank[caseMax]) w.push({ bad: true, text: 'Main ' + mf.replace('MATX', 'M-ATX') + ' lớn hơn vỏ case (chỉ hỗ trợ tới ' + caseMax.replace('MATX', 'M-ATX') + ').' });
        }
        if (psu) {
          var watt = num(psu.specs.watt) || num((psu.name.match(/(\d{3,4})\s*W\b/i) || [])[1]);
          var rec = vga && num(vga.specs.psu_w);
          var need = (num(cpu && cpu.specs.tdp_w) || 65) + (num(vga && vga.specs.power_w) || 0) + 80;
          if (watt && rec && watt < rec) w.push({ bad: true, text: 'Nguồn ' + watt + 'W thấp hơn mức hãng khuyến nghị cho VGA (' + rec + 'W).' });
          else if (watt && vga && num(vga.specs.power_w) && watt * 0.8 < need) w.push({ bad: false, text: 'Nguồn ' + watt + 'W hơi sát công suất cấu hình (≈ ' + need + 'W), nên chọn nguồn mạnh hơn.' });
        }
        if (cpu || main) {
          var miss = [['cpu', 'CPU'], ['main', 'Main'], ['ram', 'RAM'], ['storage', 'Ổ cứng'], ['psu', 'Nguồn'], ['case', 'Vỏ case']]
            .filter(function (t) { return !self.lines.some(function (l) { var p = self.part(l); return p && p.type === t[0]; }); }).map(function (t) { return t[1]; });
          if (miss.length) w.push({ bad: false, text: 'Chưa chọn: ' + miss.join(', ') + '.' });
        }
        return w;
      },

      // ---- lưu / in / bán ----
      payload: function () {
        return {
          id: this.id, name: this.name, customer_name: this.customer_name, customer_phone: this.customer_phone, customer_addr: this.customer_addr,
          note: this.note, discount: this.discount, deposit: this.deposit, is_template: this.is_template ? 1 : 0,
          items: this.lines.map(function (l) { return { part_id: l.part_id, category: l.category, name: l.name, condition: l.condition, price: l.price, qty: l.qty, warranty_months: l.warranty_months, note: l.note }; }),
        };
      },
      save: function () {
        var self = this;
        this.err = ''; this.msg = ''; this.saving = true;
        return api('/staff/api/build', { method: 'POST', body: this.payload() })
          .then(function (d) {
            self.id = d.id; self.code = d.code; self.msg = d.message; self.dirty = false;
            if (window.location.pathname !== '/staff/build/' + d.id) history.replaceState(null, '', '/staff/build/' + d.id);
            return d;
          })
          .catch(function (e) { self.err = e.message; throw e; })
          .finally(function () { self.saving = false; });
      },
      print: function (lang, doc) {
        var self = this;
        var w = window.open('about:blank', '_blank'); // mở ngay trong lúc bấm (tránh bị chặn popup), lưu xong mới chuyển trang
        var go = function () { var url = '/staff/build/' + self.id + '/print?lang=' + lang + '&doc=' + doc; if (w) w.location = url; else window.location = url; };
        if (this.id && !this.dirty) return go();
        this.save().then(go).catch(function () { if (w) w.close(); });
      },
      sell: function () {
        var self = this;
        if (this.orderCount && !confirm(this.orderCount + ' món chưa có đủ trong kho (Hàng đặt) — vẫn chốt bán? Các món đó sẽ ghi là "hàng ngoài kho".')) return;
        this.save().then(function (d) { self.dirty = false; window.location = '/staff/sell?build=' + d.id; }).catch(function () {});
      },
    });
  };
})();

// Trang test phần cứng /test: bàn phím, màn hình (điểm chết), loa trái/phải, mic, webcam, chuột/touchpad
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var TESTS = { kb: 'Bàn phím', screen: 'Màn hình', speaker: 'Loa', mic: 'Mic', cam: 'Webcam', mouse: 'Chuột' };
  var result = {};

  // ---- Kết quả Đạt / Lỗi ----
  function renderChips() {
    $('chips').innerHTML = Object.keys(TESTS).map(function (k) {
      var r = result[k];
      var cls = r === 'ok' ? 'bg-emerald-600' : r === 'bad' ? 'bg-red-600' : 'bg-slate-800 text-slate-400';
      return '<span class="rounded-full px-2.5 py-1 ' + cls + '">' + TESTS[k] + (r === 'ok' ? ' ✓' : r === 'bad' ? ' ✗' : '') + '</span>';
    }).join('');
  }
  document.querySelectorAll('[data-result]').forEach(function (el) {
    var k = el.dataset.result;
    el.innerHTML = '<button data-v="ok" class="rounded-lg bg-emerald-700 px-4 py-2 font-semibold hover:bg-emerald-600">Đạt</button>' +
      '<button data-v="bad" class="rounded-lg bg-red-700 px-4 py-2 font-semibold hover:bg-red-600">Lỗi</button>';
    el.addEventListener('click', function (e) {
      var v = e.target.dataset && e.target.dataset.v;
      if (!v) return;
      result[k] = v; renderChips();
    });
  });
  renderChips();

  // ---- Tab ----
  var curTab = '';
  function showTab(t) {
    curTab = t;
    document.querySelectorAll('[data-pane]').forEach(function (p) { p.classList.toggle('hidden', p.dataset.pane !== t); });
    document.querySelectorAll('.hw-tab').forEach(function (b) {
      var on = b.dataset.tab === t;
      b.className = 'hw-tab rounded-lg px-3 py-1.5 text-sm ' + (on ? 'bg-brand-600 font-semibold text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800');
    });
  }
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (b) { showTab(b.dataset.tab); b.blur(); if (b.dataset.tab === 'kb') sizeKb(); } });
  showTab('kb');
  setTimeout(function () { sizeKb(); }, 0);
  if (!window.isSecureContext) $('insecure').classList.remove('hidden');

  // ---- Bàn phím ----
  var F = function (n) { return ['F' + n, 'F' + n, 1]; };
  var ROWS = [
    [['Escape', 'Esc', 1], F(1), F(2), F(3), F(4), F(5), F(6), F(7), F(8), F(9), F(10), F(11), F(12), ['PrintScreen', 'PrtSc', 1], ['Insert', 'Ins', 1], ['Delete', 'Del', 1]],
    [['Backquote', '`', 1], ['Digit1', '1', 1], ['Digit2', '2', 1], ['Digit3', '3', 1], ['Digit4', '4', 1], ['Digit5', '5', 1], ['Digit6', '6', 1], ['Digit7', '7', 1], ['Digit8', '8', 1], ['Digit9', '9', 1], ['Digit0', '0', 1], ['Minus', '-', 1], ['Equal', '=', 1], ['Backspace', '⌫ Back', 2], ['Home', 'Home', 1]],
    [['Tab', 'Tab', 1.5], ['KeyQ', 'Q', 1], ['KeyW', 'W', 1], ['KeyE', 'E', 1], ['KeyR', 'R', 1], ['KeyT', 'T', 1], ['KeyY', 'Y', 1], ['KeyU', 'U', 1], ['KeyI', 'I', 1], ['KeyO', 'O', 1], ['KeyP', 'P', 1], ['BracketLeft', '[', 1], ['BracketRight', ']', 1], ['Backslash', '\\', 1.5], ['PageUp', 'PgUp', 1]],
    [['CapsLock', 'Caps', 1.75], ['KeyA', 'A', 1], ['KeyS', 'S', 1], ['KeyD', 'D', 1], ['KeyF', 'F', 1], ['KeyG', 'G', 1], ['KeyH', 'H', 1], ['KeyJ', 'J', 1], ['KeyK', 'K', 1], ['KeyL', 'L', 1], ['Semicolon', ';', 1], ['Quote', "'", 1], ['Enter', 'Enter ↵', 2.25], ['PageDown', 'PgDn', 1]],
    [['ShiftLeft', 'Shift', 2.25], ['KeyZ', 'Z', 1], ['KeyX', 'X', 1], ['KeyC', 'C', 1], ['KeyV', 'V', 1], ['KeyB', 'B', 1], ['KeyN', 'N', 1], ['KeyM', 'M', 1], ['Comma', ',', 1], ['Period', '.', 1], ['Slash', '/', 1], ['ShiftRight', 'Shift', 1.75], ['ArrowUp', '↑', 1], ['End', 'End', 1]],
    [['ControlLeft', 'Ctrl', 1.25], ['MetaLeft', 'Win', 1.25], ['AltLeft', 'Alt', 1.25], ['Space', 'Space', 5.75], ['AltRight', 'Alt', 1.25], ['ContextMenu', 'Menu', 1], ['ControlRight', 'Ctrl', 1.25], ['ArrowLeft', '←', 1], ['ArrowDown', '↓', 1], ['ArrowRight', '→', 1]],
  ];
  var NUM = [
    [['NumLock', 'Num', 1], ['NumpadDivide', '/', 1], ['NumpadMultiply', '*', 1], ['NumpadSubtract', '-', 1]],
    [['Numpad7', '7', 1], ['Numpad8', '8', 1], ['Numpad9', '9', 1], ['NumpadAdd', '+', 1]],
    [['Numpad4', '4', 1], ['Numpad5', '5', 1], ['Numpad6', '6', 1], ['ScrollLock', 'ScrLk', 1]],
    [['Numpad1', '1', 1], ['Numpad2', '2', 1], ['Numpad3', '3', 1], ['NumpadEnter', 'Enter', 1]],
    [['Numpad0', '0', 2], ['NumpadDecimal', '.', 1], ['Pause', 'Pause', 1]],
  ];
  var keyEls = {}, pressed = {};
  function block(rows, title) {
    var wrap = document.createElement('div');
    wrap.innerHTML = '<p class="mb-1 text-xs text-slate-500">' + title + '</p>';
    rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'mb-1 flex gap-1';
      r.forEach(function (k) {
        var el = document.createElement('div');
        el.className = 'grid shrink-0 select-none place-items-center rounded-md border border-slate-700 bg-slate-900 px-1 text-slate-300';
        el.dataset.u = k[2];
        el.textContent = k[1];
        keyEls[k[0]] = el;
        row.appendChild(el);
      });
      wrap.appendChild(row);
    });
    return wrap;
  }
  $('kb').appendChild(block(ROWS, 'Bàn phím chính'));
  $('kb').appendChild(block(NUM, 'Bàn phím số (nếu có)'));
  $('kb-total').textContent = Object.keys(keyEls).length;
  // Phóng bàn phím theo bề ngang màn hình: phần chính 16 phím + bàn phím số 4 phím
  function sizeKb() {
    var avail = $('kb-wrap').clientWidth - 20;
    if (avail <= 0) return;
    var U = Math.max(30, Math.floor((avail - 16) / 20));
    Object.keys(keyEls).forEach(function (c) {
      var el = keyEls[c];
      el.style.width = (el.dataset.u * U - 4) + 'px';
      el.style.height = Math.round(U * 0.85) + 'px';
      el.style.fontSize = Math.max(11, Math.round(U * 0.26)) + 'px';
    });
  }
  window.addEventListener('resize', sizeKb);
  document.addEventListener('fullscreenchange', function () {
    sizeKb();
    $('kb-full').textContent = document.fullscreenElement ? 'Thoát toàn màn hình' : 'Toàn màn hình';
    if (!document.fullscreenElement && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  });
  // Toàn màn hình + khóa bàn phím (Chrome/Edge): bắt được cả Esc, Alt, F11... — giữ Esc để thoát
  $('kb-full').addEventListener('click', function () {
    this.blur();
    if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); return; }
    document.documentElement.requestFullscreen().then(function () {
      if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(function () {});
    }).catch(function () {});
  });

  function paintKey(code, down) {
    var el = keyEls[code];
    if (!el) return;
    if (down) pressed[code] = true;
    el.className = el.className.replace(/ (bg|border|text)-(sky|emerald|slate)-\d+/g, '') +
      (down ? ' bg-sky-500 border-sky-300 text-white' : pressed[code] ? ' bg-emerald-600 border-emerald-400 text-white' : ' bg-slate-900 border-slate-700 text-slate-300');
    $('kb-count').textContent = Object.keys(pressed).length;
  }
  document.addEventListener('keydown', function (e) {
    if (/^(SELECT|INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (screenOn) return screenKey(e);
    if (curTab !== 'kb') return;
    e.preventDefault();
    paintKey(e.code, true);
    $('kb-last').textContent = e.code + (e.key && e.key.length === 1 ? ' (' + e.key + ')' : '');
  });
  document.addEventListener('keyup', function (e) {
    if (curTab !== 'kb' || screenOn) return;
    e.preventDefault();
    if (e.code === 'PrintScreen') pressed[e.code] = true; // PrtSc thường chỉ báo keyup
    paintKey(e.code, false);
  });
  window.addEventListener('blur', function () { Object.keys(keyEls).forEach(function (c) { paintKey(c, false); }); });
  $('kb-reset').addEventListener('click', function () { pressed = {}; Object.keys(keyEls).forEach(function (c) { paintKey(c, false); }); $('kb-last').textContent = '—'; this.blur(); });

  // ---- Màn hình ----
  var COLORS = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#808080', '#ffff00', '#00ffff', '#ff00ff',
    'linear-gradient(to right, #000, #fff)', 'linear-gradient(to bottom, #f00, #0f0, #00f)'];
  var NAMES = ['Đen', 'Trắng', 'Đỏ', 'Xanh lá', 'Xanh dương', 'Xám', 'Vàng', 'Cyan', 'Hồng', 'Dải xám', 'Dải màu'];
  var screenOn = false, ci = 0, full = $('screen-full');
  $('screen-swatches').innerHTML = COLORS.map(function (c, i) {
    return '<button data-ci="' + i + '" title="' + NAMES[i] + '" class="h-10 rounded border border-slate-700" style="background:' + c + '"></button>';
  }).join('');
  function paintScreen() { full.style.background = COLORS[ci]; }
  function startScreen(i) {
    ci = i || 0; screenOn = true; paintScreen(); full.classList.remove('hidden');
    if (full.requestFullscreen) full.requestFullscreen().catch(function () {});
  }
  function stopScreen() {
    screenOn = false; full.classList.add('hidden');
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  }
  function screenKey(e) {
    e.preventDefault();
    if (e.key === 'Escape') return stopScreen();
    if (e.key === 'ArrowLeft') ci = (ci - 1 + COLORS.length) % COLORS.length;
    else ci = (ci + 1) % COLORS.length;
    paintScreen();
  }
  $('screen-start').addEventListener('click', function () { startScreen(0); });
  $('screen-swatches').addEventListener('click', function (e) { var b = e.target.closest('[data-ci]'); if (b) startScreen(+b.dataset.ci); });
  full.addEventListener('click', function () { ci = (ci + 1) % COLORS.length; paintScreen(); });
  full.addEventListener('contextmenu', function (e) { e.preventDefault(); stopScreen(); });
  document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement && screenOn) stopScreen(); });

  // ---- Loa ----
  var ac = null;
  function ctx() { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); return ac; }
  function tone(pan, freq, sec) {
    var a = ctx(), o = a.createOscillator(), g = a.createGain(), p = a.createStereoPanner();
    o.frequency.value = freq || 440; p.pan.value = pan;
    g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.4, a.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + (sec || 1.2));
    o.connect(g).connect(p).connect(a.destination);
    o.start(); o.stop(a.currentTime + (sec || 1.2));
    return o;
  }
  document.querySelectorAll('[data-tone]').forEach(function (b) { b.addEventListener('click', function () { tone(+b.dataset.tone, 440, 1.2); }); });
  $('sweep').addEventListener('click', function () {
    var a = ctx(), o = tone(0, 80, 6);
    o.frequency.setValueAtTime(80, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(12000, a.currentTime + 6);
  });

  // ---- Thiết bị (mic / webcam) ----
  function fillDevices(kind, sel) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (ds) {
      var list = ds.filter(function (d) { return d.kind === kind; });
      var cur = $(sel).value;
      $(sel).innerHTML = list.map(function (d, i) { return '<option value="' + d.deviceId + '">' + (d.label || (kind === 'audioinput' ? 'Micro ' : 'Webcam ') + (i + 1)) + '</option>'; }).join('') || '<option value="">(không thấy thiết bị)</option>';
      if (cur) $(sel).value = cur;
    });
  }
  function noMedia(msgId) {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) return false;
    $(msgId).textContent = 'Trình duyệt chặn Mic / Webcam ở trang không phải https — mở bằng script Test phần cứng trong menu /shel.';
    return true;
  }
  fillDevices('audioinput', 'mic-dev'); fillDevices('videoinput', 'cam-dev');

  // ---- Mic ----
  var micStream = null, micRaf = 0;
  function stopMic() { if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); }); cancelAnimationFrame(micRaf); micStream = null; }
  $('mic-start').addEventListener('click', function () {
    if (noMedia('mic-msg')) return;
    stopMic();
    var id = $('mic-dev').value;
    navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true }).then(function (s) {
      micStream = s; $('mic-msg').textContent = ''; $('mic-rec').disabled = false;
      fillDevices('audioinput', 'mic-dev');
      var a = ctx(), an = a.createAnalyser(); an.fftSize = 1024;
      a.createMediaStreamSource(s).connect(an);
      var buf = new Uint8Array(an.fftSize);
      (function loop() {
        an.getByteTimeDomainData(buf);
        var peak = 0; for (var i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
        $('mic-level').style.width = Math.min(100, peak / 128 * 160) + '%';
        micRaf = requestAnimationFrame(loop);
      })();
    }).catch(function (e) { $('mic-msg').textContent = 'Không mở được mic: ' + e.message; });
  });
  $('mic-rec').addEventListener('click', function () {
    if (!micStream) return;
    var btn = this, chunks = [], rec = new MediaRecorder(micStream);
    rec.ondataavailable = function (e) { chunks.push(e.data); };
    rec.onstop = function () {
      var p = $('mic-play'); p.src = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType })); p.classList.remove('hidden'); p.play();
      btn.disabled = false; btn.textContent = 'Ghi 5 giây';
    };
    rec.start(); btn.disabled = true; btn.textContent = 'Đang ghi...';
    setTimeout(function () { rec.stop(); }, 5000);
  });

  // ---- Webcam ----
  var camStream = null;
  $('cam-start').addEventListener('click', function () {
    if (noMedia('cam-msg')) return;
    if (camStream) camStream.getTracks().forEach(function (t) { t.stop(); });
    var id = $('cam-dev').value;
    navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { exact: id }, width: { ideal: 1920 } } : { width: { ideal: 1920 } } }).then(function (s) {
      camStream = s; $('cam-video').srcObject = s; $('cam-msg').textContent = '';
      fillDevices('videoinput', 'cam-dev');
      var st = s.getVideoTracks()[0].getSettings();
      $('cam-info').textContent = (st.width || '?') + '×' + (st.height || '?') + (st.frameRate ? ' @ ' + Math.round(st.frameRate) + 'fps' : '');
    }).catch(function (e) { $('cam-msg').textContent = 'Không mở được webcam: ' + e.message; });
  });

  // ---- Chuột / Touchpad ----
  var cnt = { 0: 0, 1: 0, 2: 0, dbl: 0, up: 0, down: 0 };
  function bump(k) { cnt[k]++; $('m-' + k).textContent = cnt[k]; }
  var pad = $('m-pad'), g2 = pad.getContext('2d'), drawing = false, last = null;
  function sizePad() { var r = pad.getBoundingClientRect(); pad.width = r.width; pad.height = r.height; }
  pad.addEventListener('mousedown', function (e) { e.preventDefault(); bump(e.button in cnt ? e.button : 0); drawing = true; last = [e.offsetX, e.offsetY]; });
  pad.addEventListener('dblclick', function () { bump('dbl'); });
  pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  pad.addEventListener('wheel', function (e) { e.preventDefault(); bump(e.deltaY < 0 ? 'up' : 'down'); }, { passive: false });
  pad.addEventListener('mousemove', function (e) {
    if (!pad.width) sizePad();
    g2.fillStyle = drawing ? '#38bdf8' : '#475569';
    g2.fillRect(e.offsetX - 1, e.offsetY - 1, 2, 2);
    if (drawing && last) {
      g2.strokeStyle = '#38bdf8'; g2.lineWidth = 3; g2.lineCap = 'round';
      g2.beginPath(); g2.moveTo(last[0], last[1]); g2.lineTo(e.offsetX, e.offsetY); g2.stroke();
      last = [e.offsetX, e.offsetY];
    }
  });
  window.addEventListener('mouseup', function () { drawing = false; last = null; });
  $('m-clear').addEventListener('click', function () { sizePad(); });
  document.querySelector('[data-tab="mouse"]').addEventListener('click', function () { setTimeout(sizePad, 0); });
})();

/* HILL Overtime – cầu nối PWA
 * - Thay google.script.run (chỉ chạy trong Apps Script) bằng fetch tới Web App API.
 * - Hỏi mã truy cập 1 lần, nhớ trên thiết bị.
 * - Mất mạng: đọc bản lưu gần nhất, ghi thay đổi vào hàng đợi rồi tự gửi lên sheet khi có mạng.
 * Giao diện cũ giữ nguyên, vẫn gọi google.script.run.xxx như trước. */
(function () {
  'use strict';
  var CFG = window.HILL_CONFIG || {};
  var K = { token: 'hill.token', cache: 'hill.cache', queue: 'hill.queue' };
  var TIMEOUT = 30000;
  var offline = !navigator.onLine;
  var gated = false;      // true: đang bị chặn bởi màn hình bắt buộc cài app, chưa được gọi API / hỏi mã

  function $(id) { return document.getElementById(id); }
  function get(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function p2(n) { return String(n).padStart(2, '0'); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function localIso() {        // ngày theo đồng hồ của máy đang dùng (không phụ thuộc múi giờ của sheet)
    var n = new Date();
    return n.getFullYear() + '-' + p2(n.getMonth() + 1) + '-' + p2(n.getDate());
  }
  function netErr(m) { var e = new Error(m || 'Không có kết nối mạng'); e.net = true; return e; }

  /* ---------- màn hình khởi động: tắt khi số liệu đã tải xong (tối thiểu 0,8 giây cho khỏi chớp) ---------- */
  var splashAt = Date.now(), splashGone = false;
  function hideSplash(now) {
    if (splashGone) return;
    splashGone = true;
    var el = $('splash');
    if (!el) return;
    var wait = now ? 0 : Math.max(0, 800 - (Date.now() - splashAt));
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 500);
    }, wait);
  }

  /* ---------- giao diện phụ: thanh trạng thái + hộp nhập mã ---------- */
  function buildUi() {
    document.body.insertAdjacentHTML('beforeend',
      '<div class="netbar glass" id="hillNet" hidden role="status"></div>' +
      '<div class="sheet" id="hillLock" hidden><div class="panel glass">' +
      '<div class="grab"></div><h3>Nhập mã truy cập</h3>' +
      '<input id="hillLockIn" type="password" autocomplete="current-password" placeholder="Mã truy cập" aria-label="Mã truy cập">' +
      '<div class="hint" id="hillLockMsg"></div>' +
      '<button class="primary" id="hillLockGo">Vào app</button></div></div>');
  }

  /* ---------- gọi API ---------- */
  function post(body) {
    var url = CFG.API_URL;
    if (!url || url.indexOf('/macros/') < 0) {
      return Promise.reject(new Error('Chưa dán địa chỉ Web App vào file config.js'));
    }
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT) : 0;
    // text/plain để trình duyệt không gửi preflight (Apps Script không trả lời OPTIONS)
    return fetch(url, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) { clearTimeout(timer); return r; },
            function () { clearTimeout(timer); throw netErr(); })
      .then(function (r) {
        if (!r.ok) throw netErr('Máy chủ phản hồi lỗi ' + r.status);
        return r.json().catch(function () {
          throw new Error('Phản hồi không hợp lệ. Kiểm tra Deploy: "Ai có quyền truy cập" phải là "Bất kỳ ai".');
        });
      })
      .then(function (j) {
        if (j && j.ok) return j;
        var e = new Error((j && j.error) || 'Lỗi không rõ');
        e.code = j && j.code;
        throw e;
      });
  }

  var asking = null;
  function askToken(msg) {
    if (asking) return asking;
    asking = new Promise(function (resolve) {
      var box = $('hillLock'), inp = $('hillLockIn');
      hideSplash(true);                       // để hộp nhập mã không bị che
      $('hillLockMsg').textContent = msg || 'Nhập một lần, thiết bị này sẽ nhớ.';
      box.hidden = false;
      setTimeout(function () { inp.focus(); }, 80);
      function go() {
        var v = inp.value.trim();
        if (!v) return;
        inp.value = ''; box.hidden = true; asking = null;
        set(K.token, v); resolve(v);
      }
      $('hillLockGo').onclick = go;
      inp.onkeydown = function (e) { if (e.key === 'Enter') go(); };
    });
    return asking;
  }

  function call(action, payload, tries) {
    if (gated) return new Promise(function () {});     // chưa cài app thì không gọi gì, không hỏi mã
    tries = tries || 0;
    var used = null, t = get(K.token);
    return (t ? Promise.resolve(t) : askToken()).then(function (tk) {
      used = tk;
      var b = { action: action, token: tk };
      for (var k in payload) b[k] = payload[k];
      return post(b);
    }).catch(function (e) {
      if (e && e.code === 'AUTH' && tries < 8) {
        var now = get(K.token);
        if (now && now !== used) return call(action, payload, tries + 1);   // mã đã được nhập lại ở nơi khác
        del(K.token);
        return askToken('Mã chưa đúng, nhập lại nhé.').then(function () { return call(action, payload, tries + 1); });
      }
      throw e;
    });
  }

  /* ---------- bản lưu trên máy + hàng đợi ---------- */
  function queue() { return get(K.queue) || []; }
  function rowOf(data, iso) {
    var rs = (data && data.rows) || [];
    for (var i = 0; i < rs.length; i++) if (rs[i].d === iso) return rs[i];
    return null;
  }
  function applyTo(r, h, ra, rate) {     // cùng quy tắc với hàm save() trong giao diện
    var w = h > 0;
    r.h = w ? h : 0; r.t = w ? h * rate : 0; r.o = w ? ra : ''; r.n = w ? 'GOOD' : 'Không sao';
  }
  function patchCache(iso, h, ra) {
    var c = get(K.cache), r = c && rowOf(c, iso);
    if (r) { applyTo(r, h, ra, c.rate); set(K.cache, c); }
  }
  function putRec(rec) {
    var c = get(K.cache);
    if (!c || !rec || queue().some(function (x) { return x.iso === rec.d; })) return;
    for (var i = 0; i < c.rows.length; i++) if (c.rows[i].r === rec.r) { c.rows[i] = rec; break; }
    set(K.cache, c);
  }
  function applyQueue(d) {
    queue().forEach(function (it) { var r = rowOf(d, it.iso); if (r) applyTo(r, it.h, it.ra, d.rate); });
    return d;
  }
  function enqueue(iso, h, ra) {
    var q = queue().filter(function (x) { return x.iso !== iso; });
    q.push({ iso: iso, h: h, ra: ra, t: Date.now() });
    set(K.queue, q);
    setOffline(true);
    var c = get(K.cache), r = c && rowOf(c, iso);
    return r ? clone(r) : {};
  }
  function drop(it) {
    set(K.queue, queue().filter(function (x) { return !(x.iso === it.iso && x.t === it.t); }));
  }

  function paint() {
    var el = $('hillNet');
    if (!el) return;
    var n = queue().length, txt = '';
    if (offline) txt = 'Đang offline' + (n ? ' · ' + n + ' thay đổi chờ đồng bộ' : '');
    else if (n) txt = 'Đang đồng bộ ' + n + ' thay đổi…';
    el.textContent = txt; el.hidden = !txt;
  }
  function setOffline(v) { offline = v; paint(); }

  var flushing = null;
  function flush() {
    if (flushing) return flushing;
    if (!queue().length) return Promise.resolve();
    function next() {
      var it = queue()[0];
      if (!it) return Promise.resolve();
      return call('saveDay', { iso: it.iso, hours: it.h, ra: it.ra }).then(function (j) {
        drop(it); putRec(j.rec); return next();
      }, function (e) {
        if (e && e.net) throw e;                                  // mất mạng: giữ nguyên hàng đợi
        drop(it); console.warn('Bỏ qua một thay đổi bị sheet từ chối:', e && e.message);
        return next();
      });
    }
    paint();
    flushing = next().then(function () { setOffline(false); }, function () { setOffline(true); })
      .then(function () { flushing = null; paint(); });
    return flushing;
  }

  /* ---------- 2 hàm giao diện đang dùng ---------- */
  function getData() {
    return flush().then(function () { return call('getData', {}); }).then(function (j) {
      var d = applyQueue(j.data);
      d.today = localIso();            // "hôm nay" lấy theo đồng hồ máy, tránh lệch khi múi giờ sheet khác Việt Nam
      set(K.cache, d); setOffline(false);
      return d;
    }, function (e) {
      var c = e && e.net ? get(K.cache) : null;
      if (!c) throw e;
      setOffline(true);
      var d = clone(c);
      d.today = localIso();
      return d;
    });
  }

  var chain = Promise.resolve();     // gửi lần lượt để sheet nhận đúng thứ tự
  function saveDay(iso, h, ra) {
    h = Number(h) || 0; ra = String(ra || '');
    patchCache(iso, h, ra);
    var job = chain.then(function () {
      return flush().then(function () {
        if (queue().length) return enqueue(iso, h, ra);           // còn việc tồn đọng nghĩa là đang offline
        return call('saveDay', { iso: iso, hours: h, ra: ra }).then(function (j) {
          setOffline(false); putRec(j.rec); return j.rec;
        }, function (e) {
          if (e && e.net) return enqueue(iso, h, ra);
          throw e;
        });
      });
    });
    chain = job.catch(function () {});
    return job;
  }

  /* google.script.run giả lập: giữ nguyên cách gọi của giao diện cũ */
  function Runner(ok, fail) { this._ok = ok; this._fail = fail; }
  Runner.prototype.withSuccessHandler = function (f) { return new Runner(f, this._fail); };
  Runner.prototype.withFailureHandler = function (f) { return new Runner(this._ok, f); };
  var API = { getData: getData, saveDay: saveDay };
  Object.keys(API).forEach(function (name) {
    Runner.prototype[name] = function () {
      var self = this;
      API[name].apply(null, arguments).then(
        function (v) { if (self._ok) self._ok(v); if (name === 'getData') hideSplash(); },
        function (e) { if (self._fail) self._fail(e); else console.error(e); if (name === 'getData') hideSplash(); });
    };
  });
  window.google = { script: { run: new Runner() } };

  /* ---------- nút "Cài app về máy" ----------
     Android / máy tính (Chrome, Edge): bấm là hiện hộp cài đặt của trình duyệt.
     iPhone và trình duyệt trong Zalo/Facebook: không cài tự động được nên hiện hướng dẫn từng bước. */
  (function () {
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    var host = $('v-home'), anchor = host && host.querySelector('.cols');
    if (standalone || !host || !anchor) return;                 // đã cài rồi thì không hiện nút

    var ua = navigator.userAgent;
    var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var inApp = /Zalo|FBAN|FBAV|FB_IAB|Messenger|Instagram|Line\/|MicroMessenger|TikTok|Snapchat/i.test(ua);
    var KEY = 'hill.installHide', DAY = 86400000, deferred = null;

    /* Điện thoại / máy tính bảng mở bằng trình duyệt: phải cài app trước rồi mới được nhập mã.
       Lối riêng cho chủ app: thêm #web vào cuối link một lần, máy đó sẽ nhớ và dùng thẳng trình duyệt. */
    var mobile = ios || /Android/i.test(ua);
    try { if (/[#&]web\b/.test(location.hash)) set('hill.web', 1); } catch (e) {}
    if (mobile && !get('hill.web')) { gated = true; buildGate(); return; }

    var bar = document.createElement('section');
    bar.className = 'card glass'; bar.id = 'hillInstall';
    bar.hidden = Date.now() < Number(get(KEY) || 0);
    bar.innerHTML =
      '<img src="icons/logo-mark.png" alt="" width="38" height="38">' +
      '<div class="tx"><b>Cài app về máy</b><small>Mở như app thường, dùng được cả khi mất mạng</small></div>' +
      '<button class="primary" id="hillInstallGo">Cài</button>' +
      '<button id="hillInstallX" aria-label="Để sau">×</button>';
    anchor.parentNode.insertBefore(bar, anchor);

    function how() {
      if (inApp) return { t: 'Mở bằng trình duyệt trước', copy: true, s: [
        'Bạn đang mở link trong ứng dụng khác (Zalo, Facebook...), chỗ này <b>không cài được</b>.',
        'Bấm nút <b>⋯</b> hoặc biểu tượng trình duyệt ở góc màn hình, chọn <b>Mở bằng trình duyệt</b> (Safari hoặc Chrome).',
        'Hoặc bấm <b>Sao chép link</b> bên dưới, rồi dán vào Safari/Chrome.',
        'Mở lại trang rồi bấm nút <b>Cài</b>.'] };
      if (ios) return { t: 'Cài app trên iPhone / iPad', s: [
        'Mở link này bằng <b>Safari</b> (không phải Zalo hay Facebook).',
        'Bấm nút <b>Chia sẻ</b> (hình vuông có mũi tên hướng lên) ở thanh dưới.',
        'Kéo xuống, chọn <b>Thêm vào MH chính</b>.',
        'Bấm <b>Thêm</b>. Biểu tượng HILL sẽ nằm ngoài màn hình chính.'] };
      return { t: 'Cài app về máy', s: [
        'Bấm menu <b>⋮</b> của trình duyệt (góc trên bên phải).',
        'Chọn <b>Cài đặt ứng dụng</b> hoặc <b>Thêm vào màn hình chính</b>.',
        'Bấm <b>Cài đặt</b>.'] };
    }

    function buildGate() {
      var c = how();
      var g = document.createElement('div');
      g.id = 'hillGate';
      g.innerHTML = '<div class="gw" id="hillGateBody">' +
        '<img src="icons/logo-mark.png" alt="" width="84" height="84">' +
        '<h2>Cài app HILL Overtime</h2>' +
        '<p>Cài app về màn hình chính trước, rồi mở app từ đó để nhập mã truy cập.</p>' +
        '<button class="primary" id="hillGateGo" hidden>Cài app ngay</button>' +
        '<div id="hillGateHow"><ol>' + c.s.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol>' +
        (c.copy ? '<button class="primary" id="hillGateCopy">Sao chép link</button>' : '') + '</div>' +
        '<div class="foot">Đã cài rồi? Hãy mở app <b>HILL</b> ở màn hình chính, đừng mở lại link này.</div></div>';
      document.body.appendChild(g);
      if (c.copy) $('hillGateCopy').onclick = function () { copyLink(this); };

      function done() {
        $('hillGateBody').innerHTML = '<img src="icons/logo-mark.png" alt="" width="84" height="84">' +
          '<h2>Cài xong rồi!</h2><p>Giờ hãy mở app <b>HILL</b> ở màn hình chính để nhập mã và bắt đầu.</p>';
      }
      var ev = null;
      window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault(); ev = e;
        $('hillGateGo').hidden = false; $('hillGateHow').hidden = true;
      });
      window.addEventListener('appinstalled', done);
      $('hillGateGo').onclick = function () {
        if (!ev) return;
        var e = ev; ev = null;
        e.prompt();
        e.userChoice.then(function (r) {
          if (r && r.outcome === 'accepted') done();
          else { $('hillGateGo').hidden = true; $('hillGateHow').hidden = false; }   // từ chối thì hiện hướng dẫn tay
        });
      };
    }

    function copyLink(btn) {
      var url = location.href.split('#')[0];
      function done() { btn.textContent = 'Đã sao chép ✓'; }
      function fallback() {
        var t = document.createElement('textarea');
        t.value = url; t.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); done(); } catch (e) { window.prompt('Sao chép link này:', url); }
        document.body.removeChild(t);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback);
      else fallback();
    }

    function showHow() {
      var c = how(), box = $('hillHow');
      if (box) box.parentNode.removeChild(box);
      document.body.insertAdjacentHTML('beforeend',
        '<div class="sheet" id="hillHow"><div class="panel glass"><div class="grab"></div><h3>' + c.t + '</h3><ol>' +
        c.s.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol>' +
        (c.copy ? '<button class="primary" id="hillCopy">Sao chép link</button>' : '') +
        '<button class="ghost" id="hillHowOk">Đã hiểu</button></div></div>');
      box = $('hillHow');
      function close() { if (box.parentNode) box.parentNode.removeChild(box); }
      box.addEventListener('click', function (e) { if (e.target === box) close(); });
      $('hillHowOk').onclick = close;
      if (c.copy) $('hillCopy').onclick = function () { copyLink(this); };
    }

    $('hillInstallGo').onclick = function () {
      if (!deferred) { showHow(); return; }
      var ev = deferred; deferred = null;
      ev.prompt();
      ev.userChoice.then(function (r) { if (r && r.outcome === 'accepted') bar.hidden = true; });
    };
    $('hillInstallX').onclick = function () { set(KEY, Date.now() + 3 * DAY); bar.hidden = true; };
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; });
    window.addEventListener('appinstalled', function () { bar.hidden = true; del(KEY); });
  })();

  /* ---------- qua nửa đêm: app mở xuyên đêm hoặc nằm nền thì tự cập nhật "hôm nay" ---------- */
  var lastDay = localIso();
  function checkDay() {
    var n = localIso();
    if (n === lastDay) return;
    var s = $('sheet');
    if (s && !s.hidden) return;                       // đang mở hộp nhập thì chờ, không làm gián đoạn
    lastDay = n;
    var b = document.querySelector('.js-reload');
    if (b) b.click();                                 // tải lại như bấm nút ⟳
  }
  setInterval(checkDay, 30000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkDay(); });

  /* ---------- khởi động ---------- */
  buildUi();
  paint();
  setTimeout(function () { hideSplash(true); }, 12000);   // phòng khi mạng treo: không để màn khởi động che mãi
  window.addEventListener('online', function () { flush(); });
  window.addEventListener('offline', function () { setOffline(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && queue().length) flush();
  });
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW:', e); });
    });

    /* Tự cập nhật: service worker báo có bản mới thì tải lại trang, nhưng chỉ khi không làm gián đoạn
       (không đang mở hộp nhập, không đang gõ, không đang gửi dữ liệu). Tối đa 1 lần mỗi phút để không lặp. */
    var reloaded = false;
    var safeToReload = function () {
      var s = $('sheet'), l = $('hillLock'), a = document.activeElement;
      return (!s || s.hidden) && (!l || l.hidden) && !flushing && !(a && /^(INPUT|TEXTAREA)$/.test(a.tagName));
    };
    var applyUpdate = function () {
      if (reloaded) return;
      var last = 0;
      try { last = Number(sessionStorage.getItem('hill.reloadAt') || 0); } catch (e) {}
      if (Date.now() - last < 60000) return;
      (function wait() {
        if (!safeToReload()) { setTimeout(wait, 2500); return; }
        reloaded = true;
        try { sessionStorage.setItem('hill.reloadAt', String(Date.now())); } catch (e) {}
        location.reload();
      })();
    };
    navigator.serviceWorker.addEventListener('message', function (ev) {
      if (ev.data && ev.data.type === 'HILL_UPDATED') applyUpdate();
    });

    /* App cài trên điện thoại thường nằm nền rất lâu: mỗi lần quay lại (cách lần kiểm tra trước ≥ 5 phút) hỏi bản mới */
    var lastCheck = Date.now();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < 300000) return;
      lastCheck = Date.now();
      fetch('index.html', { cache: 'no-cache' }).catch(function () {});   // đi qua service worker, nó tự so sánh
    });
  }
})();

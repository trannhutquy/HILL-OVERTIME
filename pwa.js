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

  function $(id) { return document.getElementById(id); }
  function get(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function p2(n) { return String(n).padStart(2, '0'); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
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
      set(K.cache, d); setOffline(false);
      return d;
    }, function (e) {
      var c = e && e.net ? get(K.cache) : null;
      if (!c) throw e;
      setOffline(true);
      var d = clone(c), n = new Date();
      d.today = n.getFullYear() + '-' + p2(n.getMonth() + 1) + '-' + p2(n.getDate());   // lấy ngày của máy
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
  }
})();
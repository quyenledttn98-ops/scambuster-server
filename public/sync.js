/**
 * sync.js — lop dong bo may chu cho ScamBuster (ban tinh).
 *
 * File nay duoc server chen vao cuoi <body> (file public/index.html goc giu
 * nguyen). No chi "va" vao cac bien/ham global san co cua game (var PLAYERS,
 * var ACCOUNTS, var S, authSubmit, saveAccount, doCheckin, sendChat, logout,
 * renderAuth, allPlayers...) — khong sua logic Quiz/Race/Kho do.
 *
 * Nguyen tac: offline-first. Neu khong goi duoc server (mo file truc tiep,
 * mat mang), moi thu van chay nhu ban tinh cu, khong bao gio vo game.
 * Khi co server:
 *  - Dang ky/dang nhap qua /api/register + /api/login, token luu o
 *    localStorage 'scambuster-token' -> doi may van mo dung tien trinh.
 *  - GET /api/state moi 20 giay: PLAYERS duoc thay bang danh sach THAT tu
 *    server (20 nguoi mau + tat ca tai khoan that) -> BXH/Nguoi choi thay
 *    duoc tat ca nguoi da dang nhap, tai khoan cu khong "bien mat" nua.
 *  - Diem danh qua /api/checkin (server quyet dinh, lan dau = Ngay 1).
 *  - saveAccount() duoc boc them: gui tien trinh len /api/sync (debounce).
 *  - Nhan tin that qua /api/messages (nguoi mau van tra loi tu dong nhu cu;
 *    nguoi that thi cho tin that, khong gia lap).
 */
(function () {
  'use strict';
  if (typeof fetch !== 'function') return;
  var TOKEN_KEY = 'scambuster-token';
  var token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { token = null; }
  var serverUp = false;
  var showcaseNames = {}; // key chuan hoa -> true (nguoi mau)
  var realNames = [];      // ten tai khoan that tren server (de hien trong modal dang nhap)

  function keyOf(name) { return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
  function api(path, opts) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 8000);
    return fetch(path, Object.assign({ signal: ctrl.signal }, opts || {}))
      .then(function (r) { clearTimeout(t); return r.json().catch(function () { return { ok: false, error: 'May chu tra loi khong hop le.' }; }); })
      .catch(function (e) { clearTimeout(t); throw e; });
  }
  function post(path, data) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  }
  function setToken(t) {
    token = t || null;
    try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }
  // Dua player tu server ve dung hinh dang state cua game (freshState).
  function applyServerPlayer(p) {
    var st = (typeof freshState === 'function') ? freshState(p.name, p.gender || 'male') : {};
    var fields = ['xp', 'coins', 'streak', 'checkedDay', 'wins', 'quizPassed', 'quizDoneIds',
      'inboxPaid', 'linkPaidDay', 'owned', 'equipped', 'threads', 'unread'];
    fields.forEach(function (f) { if (p[f] !== undefined) st[f] = p[f]; });
    st.name = p.name; st.gender = p.gender || 'male'; st._key = keyOf(p.name);
    if (!st.threads) st.threads = {};
    if (!st.unread) st.unread = {};
    S = st;
    try { ACCOUNTS[st._key] = { pass: '', state: S }; } catch (e) {}
    return S;
  }
  function stateForSync() {
    if (!S) return null;
    var threads = {};
    Object.keys(S.threads || {}).forEach(function (k) {
      var arr = (S.threads[k] || []).slice(-50); // chi gui 50 tin moi nhat moi nguoi
      threads[k] = arr.map(function (m) { return { mine: !!m.mine, body: String(m.body || '').slice(0, 500), at: m.at || Date.now() }; });
    });
    return { xp: S.xp, coins: S.coins, wins: S.wins, quizPassed: S.quizPassed, quizDoneIds: S.quizDoneIds,
      inboxPaid: S.inboxPaid, linkPaidDay: S.linkPaidDay, owned: S.owned, equipped: S.equipped,
      threads: threads, unread: S.unread };
  }

  /* ---------- Nap danh sach nguoi choi THAT tu server ---------- */
  function refreshPlayers() {
    return api('/api/state').then(function (d) {
      if (!d || !d.ok || !Array.isArray(d.players)) return;
      serverUp = true;
      showcaseNames = {}; realNames = [];
      var mine = (typeof S !== 'undefined' && S) ? keyOf(S.name) : '';
      var list = [];
      d.players.forEach(function (p) {
        if (p.isShowcase) showcaseNames[keyOf(p.name)] = true;
        else realNames.push(p.name);
        if (keyOf(p.name) === mine) return; // S se duoc allPlayers() tu them vao (isMe=true)
        list.push({ name: p.name, gender: p.gender, xp: p.xp, coins: p.coins, streak: p.streak,
          wins: p.wins, mins: p.online ? 0 : 60, online: p.online, level: p.level, title: p.title,
          isShowcase: !!p.isShowcase });
      });
      try {
        PLAYERS.length = 0;
        list.forEach(function (p) { PLAYERS.push(p); });
        if (typeof renderBoards === 'function') renderBoards();
        if (typeof renderPlayers === 'function') renderPlayers();
      } catch (e) {}
    }).catch(function () { /* offline: giu danh sach cu */ });
  }

  /* ---------- Khoi phuc phien dang nhap khi doi may / tai lai trang ---------- */
  function restoreSession() {
    if (!token) return Promise.resolve(false);
    return post('/api/me', { token: token }).then(function (d) {
      if (!d || !d.ok || !d.player) { setToken(null); return false; }
      serverUp = true;
      applyServerPlayer(d.player);
      try { if (typeof afterAuth === 'function') afterAuth(); } catch (e) {}
      return true;
    }).catch(function () { return false; });
  }

  /* ---------- Boc ham dang nhap/dang ky goc: uu tien server, rot ve local ---------- */
  var origAuthSubmit = (typeof authSubmit === 'function') ? authSubmit : null;
  if (origAuthSubmit) {
    authSubmit = function () {
      var user = ($('authUser').value || '').trim();
      var pass = $('authPass').value || '';
      var key = keyOf(user);
      if (user.length < 2) { authError('Tên đăng nhập cần ít nhất 2 ký tự.'); return; }
      if (pass.length < 4) { authError('Mật khẩu cần ít nhất 4 ký tự.'); return; }
      var mode = (typeof authModeCur !== 'undefined') ? authModeCur : 'login';
      var gender = (typeof authGender !== 'undefined') ? authGender : 'male';
      var path = mode === 'register' ? '/api/register' : '/api/login';
      post(path, { name: user, pass: pass, gender: gender }).then(function (d) {
        if (!d || !d.ok) {
          if (d && d.error) authError(d.error);
          else origAuthSubmit(); // server khong tra loi ro: dung luong local cu
          return;
        }
        serverUp = true;
        setToken(d.token);
        applyServerPlayer(d.player);
        try { ACCOUNTS[key] = { pass: pass, state: S }; } catch (e) {}
        closeAuth(); afterAuth(); refreshPlayers();
        toast(mode === 'register'
          ? '🎉 Tạo tài khoản thành công! Tài khoản đã lưu trên máy chủ — đăng nhập ở máy khác vẫn đúng tiến trình.'
          : '👋 Xin chào lại, ' + S.name + '! Tiến trình đã đồng bộ từ máy chủ.');
      }).catch(function () {
        toast('⚠️ Chưa kết nối được máy chủ — chơi tạm trên máy này, tiến trình sẽ đồng bộ sau.');
        origAuthSubmit(); // rot ve ban local
      });
    };
  }

  /* ---------- Boc saveAccount: gui tien trinh len server (debounce) ---------- */
  var origSaveAccount = (typeof saveAccount === 'function') ? saveAccount : null;
  var syncTimer = null;
  function scheduleSync() {
    if (!token || !S) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      var st = stateForSync(); if (!st) return;
      post('/api/sync', { token: token, state: st }).catch(function () {});
    }, 400);
  }
  if (origSaveAccount) {
    saveAccount = function () { origSaveAccount(); scheduleSync(); };
  }

  /* ---------- Boc doCheckin: server quyet dinh Ngay 1 / khoa theo ngay ---------- */
  var origDoCheckin = (typeof doCheckin === 'function') ? doCheckin : null;
  if (origDoCheckin) {
    doCheckin = function () {
      if (!S) return;
      if (!token) { origDoCheckin(); return; }
      post('/api/checkin', { token: token }).then(function (d) {
        if (!d || !d.ok) { origDoCheckin(); return; }
        S.streak = d.streak; S.xp = d.xp; S.coins = d.coins; S.checkedDay = d.checkedDay;
        saveAccount(); renderHeader(); renderCheckin();
        toast(d.already
          ? 'Hôm nay bạn đã điểm danh rồi. Mai quay lại để nối chuỗi nhé!'
          : 'Điểm danh thành công! +15 ScamCoins, +5 XP. Chuỗi ' + d.streak + ' ngày 🔥');
      }).catch(function () { origDoCheckin(); });
    };
  }

  /* ---------- Boc logout: xoa session tren server ---------- */
  var origLogout = (typeof logout === 'function') ? logout : null;
  if (origLogout) {
    logout = function () {
      if (token) post('/api/logout', { token: token }).catch(function () {});
      setToken(null); origLogout();
    };
  }

  /* ---------- Nhan tin: nguoi that gui qua server, nguoi mau giu tra loi tu dong ---------- */
  var origSendChat = (typeof sendChat === 'function') ? sendChat : null;
  if (origSendChat) {
    sendChat = function () {
      var input = $('chatInput');
      if (!input || !S || !chatPartner) return;
      var body = input.value.trim(); if (!body) return;
      var partner = chatPartner;
      if (!token || showcaseNames[keyOf(partner)]) { origSendChat(); return; } // nguoi mau / offline: nhu cu
      if (!S.threads[partner]) S.threads[partner] = [];
      S.threads[partner].push({ mine: true, body: body, at: Date.now() });
      saveAccount(); renderThread($('mailUI'));
      post('/api/messages/send', { token: token, to: partner, body: body }).catch(function () {});
    };
  }

  /* ---------- Hien danh sach tai khoan THAT trong modal dang nhap ---------- */
  var origRenderAuth = (typeof renderAuth === 'function') ? renderAuth : null;
  function injectAccountList() {
    try {
      var old = document.getElementById('sb-account-list');
      if (old) old.remove();
      if (!realNames.length) return;
      var modal = $('authModal'); if (!modal) return;
      var box = document.createElement('div');
      box.id = 'sb-account-list';
      box.style.cssText = 'margin-top:12px;padding:10px 12px;border:1px solid var(--border);border-radius:12px;font-size:13px';
      box.innerHTML = '<b>👥 Tài khoản đã đăng ký trên máy chủ (' + realNames.length + '):</b><br>' +
        '<span style="color:var(--dim)">Bấm tên để điền sẵn, rồi nhập mật khẩu là vào — tài khoản cũ không bị mất.</span><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">' +
        realNames.slice(0, 30).map(function (n) {
          return '<button type="button" data-sb-name="' + n.replace(/"/g, '&quot;') + '" style="border:1px solid var(--border);border-radius:999px;padding:4px 10px;font-size:13px">' + n.replace(/</g, '&lt;') + '</button>';
        }).join('') + '</div>';
      box.addEventListener('click', function (e) {
        var b = e.target.closest('[data-sb-name]'); if (!b) return;
        var inp = $('authUser'); if (inp) { inp.value = b.getAttribute('data-sb-name'); inp.focus(); }
        if (typeof authModeCur !== 'undefined') authModeCur = 'login';
        var pw = $('authPass'); if (pw) pw.focus();
      });
      var card = modal.querySelector('.auth-card') || modal.firstElementChild || modal;
      card.appendChild(box);
    } catch (e) {}
  }
  if (origRenderAuth) {
    renderAuth = function () { origRenderAuth(); injectAccountList(); };
  }

  /* ---------- Polling: BXH + tin nhan den + heartbeat ---------- */
  function pollMessages() {
    if (!token || !S || !chatPartner) return;
    api('/api/messages?token=' + encodeURIComponent(token) + '&with=' + encodeURIComponent(chatPartner))
      .then(function (d) {
        if (!d || !d.ok || !Array.isArray(d.messages)) return;
        var th = S.threads[chatPartner] || (S.threads[chatPartner] = []);
        var changed = false;
        d.messages.forEach(function (m) {
          var dup = th.some(function (x) { return x.at === m.at && x.body === m.body && !!x.mine === !!m.mine; });
          if (!dup) { th.push({ mine: !!m.mine, body: m.body, at: m.at }); changed = true; }
        });
        if (changed) {
          th.sort(function (a, b) { return a.at - b.at; });
          saveAccount();
          if (currentTab === 'messages' && typeof renderThread === 'function') renderThread($('mailUI'));
        }
      }).catch(function () {});
  }
  setInterval(function () {
    refreshPlayers();
    if (token) { post('/api/heartbeat', { token: token }).catch(function () {}); pollMessages(); }
  }, 20000);
  setInterval(function () { if (token) post('/api/heartbeat', { token: token }).catch(function () {}); }, 25000);

  /* ---------- Khoi dong ---------- */
  api('/api/health').then(function (d) {
    if (!d || !d.ok) return;
    serverUp = true;
    refreshPlayers().then(function () { return restoreSession(); }).then(function (ok) {
      if (ok) toast('🌐 Đã kết nối máy chủ — tài khoản dùng được ở mọi thiết bị.');
      injectAccountList();
    });
  }).catch(function () { /* khong co server: choi offline nhu cu */ });

  window.__sbSync = { refresh: refreshPlayers, restore: restoreSession, get serverUp() { return serverUp; } };
})();

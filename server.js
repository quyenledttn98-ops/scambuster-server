/**
 * ScamBuster — server co may chu (Node >= 22, KHONG can cai them goi nao).
 *
 * Giai quyet dung van de cua ban tinh Netlify:
 *  - Tai khoan luu tren server (SQLite) nen dang nhap duoc o BAT KY thiet bi nao.
 *  - GET /api/state tra TOAN BO nguoi choi (nguoi mau + nguoi that) nen tab
 *    "Nguoi choi" / BXH xem duoc tat ca nguoi da dang nhap.
 *  - Diem danh do server quyet dinh theo ngay Viet Nam: lan dau = Ngay 1,
 *    header va thanh diem danh doc chung mot truong streak tren server.
 *  - Mot tong XP chung duy nhat: cap toi da 100, moi cap dung 10.000 XP.
 *  - Quiz 600 cau, Race Quest, kho do 21 mon chay o phia client (file
 *    public/index.html — ban sao y ban tinh hien tai); server luu ket qua
 *    cua chung qua POST /api/sync. Dau truong truc tiep 2 nguoi dung polling
 *    HTTP (khong can WebSocket): /api/arena/*.
 *
 * Luu y trung thuc:
 *  - Mat khau cua tai khoan cu (ban fullstack trong Muse) KHONG the chuyen
 *    sang day vi khong co hash mat khau. Nguoi choi that phai dang ky lai
 *    tren host moi (ten cu van dung duoc). 20 nguoi mau duoc seed san.
 *  - Render goi free: file SQLite nam tren o dia tam thoi, se mat khi
 *    redeploy/restart may chu. Muon giu lau dai: gan Persistent Disk
 *    (goi tra phi) hoac chuyen sang Postgres — xem README.md.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_KIND = (process.env.STORE || 'sqlite').toLowerCase();
const VERSION = '1.0.0';

const XP_PER_LEVEL = 10000;
const MAX_LEVEL = 100;
const RANKS = ['Tân Binh Tỉnh Táo', 'Thám Tử Tập Sự', 'Thám Tử Chính Thức',
  'Người Soi Link', 'Học Viên Chống Lừa', 'Chuyên Gia Soi Bẫy',
  'Cao Thủ Phá Bẫy', 'Bậc Thầy ScamBuster', 'Huyền Thoại Bảo Mật', 'Vua Săn Bẫy'];
const ONLINE_WINDOW_MS = 60 * 1000; // online = lastSeen trong 60 giay (giong ban fullstack)
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // token song 30 ngay

function levelOf(xp) { return Math.min(MAX_LEVEL, Math.floor(Math.max(0, xp) / XP_PER_LEVEL) + 1); }
function rankOf(lv) { return RANKS[Math.min(9, Math.floor((lv - 1) / 10))]; }
function normKey(name) { return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function displayName(name) { return String(name || '').trim().replace(/\s+/g, ' '); }
function nowISO() { return new Date().toISOString(); }
// Ngay theo gio Viet Nam — diem danh khoa theo ngay that o VN, khong theo UTC.
function todayKeyVN(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function hashPassword(pass, saltHex) {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pass, Buffer.from(salt, 'hex'), 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pass, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(pass, Buffer.from(salt, 'hex'), 64).toString('hex');
  const a = Buffer.from(calc, 'hex'); const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function clampInt(v, min, max, fallback = 0) {
  const n = Number(v); if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function asStringArray(v, maxLen = 5000) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' || typeof x === 'number').slice(0, maxLen);
}
function asObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

// 20 nguoi choi mau — y he ban tinh hien tai (ten, gioi tinh, XP, coins, streak, wins).
// `mins` = so phut truoc day ho online lan cuoi (0 = dang online).
const SHOWCASE = [
  { name: 'Tuấn Anh', gender: 'male', xp: 860, coins: 420, streak: 6, wins: 9, mins: 0 },
  { name: 'Văn An', gender: 'male', xp: 790, coins: 380, streak: 5, wins: 8, mins: 180 },
  { name: 'Bảo Ngọc', gender: 'female', xp: 705, coins: 350, streak: 4, wins: 7, mins: 0 },
  { name: 'Linh Chi', gender: 'female', xp: 640, coins: 300, streak: 7, wins: 6, mins: 1560 },
  { name: 'Minh Quân', gender: 'male', xp: 640, coins: 290, streak: 4, wins: 5, mins: 0 },
  { name: 'Quốc Huy', gender: 'male', xp: 575, coins: 265, streak: 3, wins: 6, mins: 300 },
  { name: 'Khanh Chi', gender: 'female', xp: 520, coins: 240, streak: 2, wins: 5, mins: 3000 },
  { name: 'Thu Hằng', gender: 'female', xp: 505, coins: 230, streak: 6, wins: 4, mins: 0 },
  { name: 'Đức Anh', gender: 'male', xp: 470, coins: 205, streak: 2, wins: 4, mins: 420 },
  { name: 'Phương Thảo', gender: 'female', xp: 455, coins: 210, streak: 5, wins: 4, mins: 600 },
  { name: 'Ngọc Anh', gender: 'female', xp: 415, coins: 190, streak: 3, wins: 3, mins: 900 },
  { name: 'Thành Lâm', gender: 'male', xp: 390, coins: 175, streak: 1, wins: 4, mins: 1800 },
  { name: 'Hoàng Nam', gender: 'male', xp: 350, coins: 160, streak: 1, wins: 3, mins: 1600 },
  { name: 'Hồng Nhung', gender: 'female', xp: 330, coins: 150, streak: 3, wins: 3, mins: 4440 },
  { name: 'Thanh Thảo', gender: 'female', xp: 300, coins: 135, streak: 4, wins: 2, mins: 2880 },
  { name: 'Nhật Minh', gender: 'male', xp: 285, coins: 120, streak: 2, wins: 3, mins: 1400 },
  { name: 'Gia Bảo', gender: 'male', xp: 240, coins: 105, streak: 2, wins: 2, mins: 0 },
  { name: 'Mai Lan', gender: 'female', xp: 185, coins: 85, streak: 1, wins: 1, mins: 4320 },
  { name: 'Phúc Thịnh', gender: 'male', xp: 130, coins: 60, streak: 0, wins: 1, mins: 5760 },
  { name: 'Khánh Linh', gender: 'female', xp: 75, coins: 35, streak: 1, wins: 0, mins: 0 },
];

/* ================= LUU TRU =================
 * Mac dinh: SQLite qua node:sqlite (co san tu Node 22, khong can npm install).
 * Du phong: STORE=json -> file JSON (data/store.json) khi host dung Node cu.
 * Ca hai deu co cung interface, de sau nay doi sang Postgres chi can them 1 store.
 */
fs.mkdirSync(DATA_DIR, { recursive: true });

function emptyState() {
  return { quizPassed: [], quizDoneIds: [], inboxPaid: [], linkPaidDay: '', owned: [], equipped: {}, threads: {}, unread: {} };
}
function publicPlayer(p, nowMs) {
  const xp = p.xp || 0; const lv = levelOf(xp);
  const online = p.is_showcase
    ? (Date.now() - Date.parse(p.last_seen_at || 0) < ONLINE_WINDOW_MS)
    : (nowMs - Date.parse(p.last_seen_at || 0) < ONLINE_WINDOW_MS);
  return { name: p.name, gender: p.gender, xp, coins: p.coins || 0, streak: p.streak || 0,
    wins: p.wins || 0, online, level: lv, title: rankOf(lv), isShowcase: !!p.is_showcase };
}
function fullPlayer(p) {
  const base = publicPlayer(p, Date.now());
  const st = p.state_json ? JSON.parse(p.state_json) : emptyState();
  return { ...base, checkedDay: p.checked_day || '', ...st, name: p.name, gender: p.gender };
}

class SqliteStore {
  constructor(file) {
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS players(
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      gender TEXT NOT NULL DEFAULT 'male', pass_hash TEXT, xp INTEGER NOT NULL DEFAULT 0,
      coins INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0,
      checked_day TEXT NOT NULL DEFAULT '', wins INTEGER NOT NULL DEFAULT 0,
      state_json TEXT NOT NULL DEFAULT '{}', is_showcase INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY, player_id INTEGER NOT NULL, created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_key TEXT NOT NULL, to_key TEXT NOT NULL,
      body TEXT NOT NULL, created_at TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS matches(
      id INTEGER PRIMARY KEY AUTOINCREMENT, a_key TEXT NOT NULL, b_key TEXT,
      status TEXT NOT NULL DEFAULT 'waiting', a_wins INTEGER NOT NULL DEFAULT 0,
      b_wins INTEGER NOT NULL DEFAULT 0, round_no INTEGER NOT NULL DEFAULT 1,
      awarded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS match_rounds(
      id INTEGER PRIMARY KEY AUTOINCREMENT, match_id INTEGER NOT NULL, round_no INTEGER NOT NULL,
      kind TEXT NOT NULL, a_score INTEGER, b_score INTEGER,
      UNIQUE(match_id, round_no));`);
    this.seed();
  }
  seed() {
    const count = this.db.prepare('SELECT COUNT(*) c FROM players WHERE is_showcase=1').get().c;
    if (count > 0) return;
    const now = Date.now();
    const ins = this.db.prepare(`INSERT INTO players
      (key,name,gender,pass_hash,xp,coins,streak,checked_day,wins,state_json,is_showcase,created_at,last_seen_at)
      VALUES (?,?,?,?,?, ?,?, '',?, '{}',1,?,?)`);
    for (const p of SHOWCASE) {
      ins.run(normKey(p.name), p.name, p.gender, null, p.xp, p.coins, p.streak, p.wins,
        nowISO(), new Date(now - p.mins * 60000).toISOString());
    }
  }
  getPlayerByKey(key) { return this.db.prepare('SELECT * FROM players WHERE key=?').get(key) || null; }
  getPlayerById(id) { return this.db.prepare('SELECT * FROM players WHERE id=?').get(id) || null; }
  listPlayers() { return this.db.prepare('SELECT * FROM players ORDER BY is_showcase ASC, xp DESC').all(); }
  insertPlayer(p) {
    const r = this.db.prepare(`INSERT INTO players
      (key,name,gender,pass_hash,xp,coins,streak,checked_day,wins,state_json,is_showcase,created_at,last_seen_at)
      VALUES (?,?,?,?,?,0,0,'',0,'{}',0,?,?)`).run(p.key, p.name, p.gender, p.pass_hash, 0, nowISO(), nowISO());
    return this.getPlayerById(r.lastInsertRowid);
  }
  updatePlayer(key, fields) {
    const keys = Object.keys(fields); if (!keys.length) return;
    const sql = `UPDATE players SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE key=?`;
    this.db.prepare(sql).run(...keys.map((k) => fields[k]), key);
  }
  touchPlayer(key) { this.updatePlayer(key, { last_seen_at: nowISO() }); }
  createSession(playerId, token) {
    this.db.prepare('INSERT INTO sessions(token,player_id,created_at,last_seen_at) VALUES (?,?,?,?)')
      .run(token, playerId, nowISO(), nowISO());
  }
  getSession(token) {
    const s = this.db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
    if (!s) return null;
    if (Date.now() - Date.parse(s.created_at) > SESSION_TTL_MS) { this.deleteSession(token); return null; }
    return s;
  }
  touchSession(token) { this.db.prepare('UPDATE sessions SET last_seen_at=? WHERE token=?').run(nowISO(), token); }
  deleteSession(token) { this.db.prepare('DELETE FROM sessions WHERE token=?').run(token); }
  insertMessage(fromKey, toKey, body) {
    const r = this.db.prepare('INSERT INTO messages(from_key,to_key,body,created_at) VALUES (?,?,?,?)')
      .run(fromKey, toKey, body, nowISO());
    return r.lastInsertRowid;
  }
  thread(a, b) {
    return this.db.prepare(`SELECT * FROM messages WHERE
      (from_key=? AND to_key=?) OR (from_key=? AND to_key=?) ORDER BY id ASC LIMIT 200`)
      .all(a, b, b, a);
  }
  markRead(toKey, fromKey) {
    this.db.prepare('UPDATE messages SET is_read=1 WHERE to_key=? AND from_key=?').run(toKey, fromKey);
  }
  unreadCount(toKey) {
    return this.db.prepare('SELECT COUNT(*) c FROM messages WHERE to_key=? AND is_read=0').get(toKey).c;
  }
  // --- Dau truong truc tiep (polling) ---
  findOpenMatchFor(key) {
    return this.db.prepare(`SELECT * FROM matches WHERE status IN ('waiting','playing')
      AND (a_key=? OR b_key=?) ORDER BY id DESC LIMIT 1`).get(key, key) || null;
  }
  findWaitingMatch(exceptKey) {
    return this.db.prepare(`SELECT * FROM matches WHERE status='waiting' AND a_key!=?
      AND created_at > datetime('now','-120 seconds') ORDER BY id ASC LIMIT 1`).get(exceptKey) || null;
  }
  createMatch(aKey) {
    const r = this.db.prepare(`INSERT INTO matches(a_key,status,created_at,updated_at) VALUES (?, 'waiting', ?, ?)`)
      .run(aKey, nowISO(), nowISO());
    return this.db.prepare('SELECT * FROM matches WHERE id=?').get(r.lastInsertRowid);
  }
  getMatch(id) { return this.db.prepare('SELECT * FROM matches WHERE id=?').get(id) || null; }
  updateMatch(id, fields) {
    const keys = Object.keys(fields); if (!keys.length) return;
    this.db.prepare(`UPDATE matches SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`)
      .run(...keys.map((k) => fields[k]), nowISO(), id);
  }
  joinMatch(id, bKey) { this.updateMatch(id, { b_key: bKey, status: 'playing' }); }
  getRound(matchId, roundNo) {
    return this.db.prepare('SELECT * FROM match_rounds WHERE match_id=? AND round_no=?').get(matchId, roundNo) || null;
  }
  upsertRound(matchId, roundNo, kind, side, score) {
    const ex = this.getRound(matchId, roundNo);
    if (!ex) {
      this.db.prepare('INSERT INTO match_rounds(match_id,round_no,kind,a_score,b_score) VALUES (?,?,?,?,?)')
        .run(matchId, roundNo, kind, side === 'a' ? score : null, side === 'b' ? score : null);
    } else {
      this.db.prepare(`UPDATE match_rounds SET ${side}_score=? WHERE match_id=? AND round_no=?`)
        .run(score, matchId, roundNo);
    }
    return this.getRound(matchId, roundNo);
  }
  listRounds(matchId) { return this.db.prepare('SELECT * FROM match_rounds WHERE match_id=? ORDER BY round_no').all(matchId); }
}

class JsonStore {
  constructor(file) {
    this.file = file;
    if (fs.existsSync(file)) { this.d = JSON.parse(fs.readFileSync(file, 'utf8')); }
    else {
      this.d = { players: [], sessions: [], messages: [], matches: [], match_rounds: [], seq: { player: 1, message: 1, match: 1, round: 1 } };
      const now = Date.now();
      for (const p of SHOWCASE) {
        this.d.players.push({ id: this.d.seq.player++, key: normKey(p.name), name: p.name, gender: p.gender,
          pass_hash: null, xp: p.xp, coins: p.coins, streak: p.streak, checked_day: '', wins: p.wins,
          state_json: '{}', is_showcase: 1, created_at: nowISO(), last_seen_at: new Date(now - p.mins * 60000).toISOString() });
      }
      this.save();
    }
  }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.d)); }
  getPlayerByKey(k) { return this.d.players.find((p) => p.key === k) || null; }
  getPlayerById(id) { return this.d.players.find((p) => p.id === id) || null; }
  listPlayers() { return [...this.d.players].sort((a, b) => a.is_showcase - b.is_showcase || b.xp - a.xp); }
  insertPlayer(p) {
    const row = { id: this.d.seq.player++, key: p.key, name: p.name, gender: p.gender, pass_hash: p.pass_hash,
      xp: 0, coins: 0, streak: 0, checked_day: '', wins: 0, state_json: '{}', is_showcase: 0,
      created_at: nowISO(), last_seen_at: nowISO() };
    this.d.players.push(row); this.save(); return row;
  }
  updatePlayer(key, fields) { const p = this.getPlayerByKey(key); if (p) { Object.assign(p, fields); this.save(); } }
  touchPlayer(key) { this.updatePlayer(key, { last_seen_at: nowISO() }); }
  createSession(playerId, token) { this.d.sessions.push({ token, player_id: playerId, created_at: nowISO(), last_seen_at: nowISO() }); this.save(); }
  getSession(token) {
    const s = this.d.sessions.find((x) => x.token === token); if (!s) return null;
    if (Date.now() - Date.parse(s.created_at) > SESSION_TTL_MS) { this.deleteSession(token); return null; }
    return s;
  }
  touchSession(token) { const s = this.getSession(token); if (s) { s.last_seen_at = nowISO(); this.save(); } }
  deleteSession(token) { this.d.sessions = this.d.sessions.filter((x) => x.token !== token); this.save(); }
  insertMessage(fromKey, toKey, body) {
    const id = this.d.seq.message++; this.d.messages.push({ id, from_key: fromKey, to_key: toKey, body, created_at: nowISO(), is_read: 0 }); this.save(); return id;
  }
  thread(a, b) {
    return this.d.messages.filter((m) => (m.from_key === a && m.to_key === b) || (m.from_key === b && m.to_key === a)).slice(0, 200);
  }
  markRead(toKey, fromKey) { this.d.messages.forEach((m) => { if (m.to_key === toKey && m.from_key === fromKey) m.is_read = 1; }); this.save(); }
  unreadCount(toKey) { return this.d.messages.filter((m) => m.to_key === toKey && !m.is_read).length; }
  findOpenMatchFor(key) {
    return [...this.d.matches].reverse().find((m) => ['waiting', 'playing'].includes(m.status) && (m.a_key === key || m.b_key === key)) || null;
  }
  findWaitingMatch(exceptKey) {
    return this.d.matches.find((m) => m.status === 'waiting' && m.a_key !== exceptKey && Date.now() - Date.parse(m.created_at) < 120000) || null;
  }
  createMatch(aKey) {
    const m = { id: this.d.seq.match++, a_key: aKey, b_key: null, status: 'waiting', a_wins: 0, b_wins: 0, round_no: 1, awarded: 0, created_at: nowISO(), updated_at: nowISO() };
    this.d.matches.push(m); this.save(); return m;
  }
  getMatch(id) { return this.d.matches.find((m) => m.id === Number(id)) || null; }
  updateMatch(id, fields) { const m = this.getMatch(id); if (m) { Object.assign(m, fields, { updated_at: nowISO() }); this.save(); } }
  joinMatch(id, bKey) { this.updateMatch(id, { b_key: bKey, status: 'playing' }); }
  getRound(matchId, roundNo) { return this.d.match_rounds.find((r) => r.match_id === Number(matchId) && r.round_no === roundNo) || null; }
  upsertRound(matchId, roundNo, kind, side, score) {
    let r = this.getRound(matchId, roundNo);
    if (!r) { r = { id: this.d.seq.round++, match_id: Number(matchId), round_no: roundNo, kind, a_score: null, b_score: null }; this.d.match_rounds.push(r); }
    r[side + '_score'] = score; this.save(); return r;
  }
  listRounds(matchId) { return this.d.match_rounds.filter((r) => r.match_id === Number(matchId)).sort((a, b) => a.round_no - b.round_no); }
}

let store;
try {
  if (STORE_KIND === 'json') throw new Error('forced json store');
  store = new SqliteStore(path.join(DATA_DIR, 'scambuster.db'));
  console.log('[store] sqlite:', path.join(DATA_DIR, 'scambuster.db'));
} catch (e) {
  store = new JsonStore(path.join(DATA_DIR, 'store.json'));
  console.log('[store] json fallback:', e.message);
}

/* ================= API ================= */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 200 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
// Chong do mat khau / spam dang ky: 30 luot/phut cho moi IP + endpoint.
const rateMap = new Map();
function rateLimited(ip, key, limit = 30) {
  const now = Date.now(); const k = `${ip}:${key}`;
  const arr = (rateMap.get(k) || []).filter((t) => now - t < 60000);
  arr.push(now); rateMap.set(k, arr);
  return arr.length > limit;
}
function authPlayer(req, body) {
  const token = body && body.token;
  if (!token || typeof token !== 'string') return null;
  const sess = store.getSession(token); if (!sess) return null;
  const player = store.getPlayerById(sess.player_id); if (!player) return null;
  store.touchSession(token); store.touchPlayer(player.key);
  return { player, token };
}

async function handleApi(req, res, url) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const body = req.method === 'POST' ? await readBody(req).catch(() => null) : {};
  if (req.method === 'POST' && body === null) return sendJson(res, 400, { ok: false, error: 'JSON khong hop le.' });

  // GET /api/health — kiem tra song, khong can dang nhap.
  if (url.pathname === '/api/health') {
    const players = store.listPlayers();
    const online = players.filter((p) => Date.now() - Date.parse(p.last_seen_at) < ONLINE_WINDOW_MS).length;
    return sendJson(res, 200, { ok: true, version: VERSION, players: players.length, online, store: STORE_KIND });
  }

  // GET /api/state — cong khai, khong can dang nhap (giong ban fullstack cu):
  // tra TOAN BO nguoi choi, online truoc roi XP giam dan.
  if (url.pathname === '/api/state' && req.method === 'GET') {
    const nowMs = Date.now();
    const players = store.listPlayers().map((p) => publicPlayer(p, nowMs))
      .sort((a, b) => (b.online - a.online) || (b.xp - a.xp) || (b.coins - a.coins));
    const onlineCount = players.filter((p) => p.online).length;
    return sendJson(res, 200, { ok: true, players, onlineCount, totalPlayers: players.length });
  }
  // GET /api/players.csv — xuat an danh cho giao vien (phuc vu NCKH): khong co mat khau.
  if (url.pathname === '/api/players.csv' && req.method === 'GET') {
    const rows = store.listPlayers().map((p) => publicPlayer(p, Date.now()));
    const csv = 'name,gender,level,title,xp,coins,streak,wins,online,isShowcase\n' +
      rows.map((p) => [p.name, p.gender, p.level, `"${p.title}"`, p.xp, p.coins, p.streak, p.wins, p.online ? 1 : 0, p.isShowcase ? 1 : 0].join(',')).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="scambuster-players.csv"' });
    return res.end(csv);
  }

  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Chi ho tro POST.' });

  // POST /api/register — ten chuan hoa (trim, gop khoang trang, lowercase) lam khoa.
  if (url.pathname === '/api/register') {
    if (rateLimited(ip, 'register')) return sendJson(res, 429, { ok: false, error: 'Ban thao tac qua nhanh, thu lai sau 1 phut.' });
    const name = displayName(body.name); const key = normKey(name);
    const pass = String(body.pass || ''); const gender = body.gender === 'female' ? 'female' : 'male';
    if (name.length < 2) return sendJson(res, 400, { ok: false, error: 'Ten dang nhap can it nhat 2 ky tu.' });
    if (pass.length < 4) return sendJson(res, 400, { ok: false, error: 'Mat khau can it nhat 4 ky tu.' });
    if (store.getPlayerByKey(key)) return sendJson(res, 409, { ok: false, error: 'Ten dang nhap nay da co nguoi dung. Neu la ban, hay bam Dang nhap va nhap dung mat khau.' });
    const player = store.insertPlayer({ key, name, gender, pass_hash: hashPassword(pass) });
    const token = newToken(); store.createSession(player.id, token);
    return sendJson(res, 200, { ok: true, token, player: fullPlayer(player) });
  }

  // POST /api/login
  if (url.pathname === '/api/login') {
    if (rateLimited(ip, 'login')) return sendJson(res, 429, { ok: false, error: 'Ban thao tac qua nhanh, thu lai sau 1 phut.' });
    const key = normKey(body.name);
    const player = store.getPlayerByKey(key);
    if (!player || !player.pass_hash) return sendJson(res, 404, { ok: false, error: `Chua co tai khoan "${displayName(body.name)}" — hay bam Dang ky moi de tao tai khoan truoc.` });
    if (!verifyPassword(String(body.pass || ''), player.pass_hash)) return sendJson(res, 401, { ok: false, error: 'Mat khau chua dung, ban thu lai nhe.' });
    const token = newToken(); store.createSession(player.id, token);
    return sendJson(res, 200, { ok: true, token, player: fullPlayer(player) });
  }

  // Cac endpoint duoi day can token.
  const auth = authPlayer(req, body);
  if (!auth && !['/api/logout'].includes(url.pathname)) {
    // /api/logout van tra ok du token het han (de client xoa token cho sach).
    if (url.pathname === '/api/logout') return sendJson(res, 200, { ok: true });
    return sendJson(res, 401, { ok: false, error: 'Phien dang nhap het han, hay dang nhap lai.' });
  }
  const me = auth?.player;

  // POST /api/me — lay lai tien trinh day du sau khi doi may / tai lai trang.
  if (url.pathname === '/api/me') return sendJson(res, 200, { ok: true, player: fullPlayer(me), unread: store.unreadCount(me.key) });

  // POST /api/logout
  if (url.pathname === '/api/logout') { if (auth) store.deleteSession(auth.token); return sendJson(res, 200, { ok: true }); }

  // POST /api/heartbeat — client goi moi 25 giay khi dang dang nhap; online = lastSeen < 60 giay.
  if (url.pathname === '/api/heartbeat') return sendJson(res, 200, { ok: true, online: true });

  // POST /api/checkin — server quyet dinh, khoa theo ngay VN. Lan dau = Ngay 1.
  if (url.pathname === '/api/checkin') {
    const today = todayKeyVN();
    if (me.checked_day === today) return sendJson(res, 200, { ok: true, already: true, streak: me.streak, xp: me.xp, coins: me.coins, checkedDay: today });
    const streak = (me.streak || 0) + 1; const xp = me.xp + 5; const coins = me.coins + 15;
    store.updatePlayer(me.key, { streak, checked_day: today, xp, coins, last_seen_at: nowISO() });
    return sendJson(res, 200, { ok: true, already: false, streak, xp, coins, checkedDay: today });
  }

  // POST /api/sync — client gui tien trinh sau moi lan choi/mua do.
  // Quy tac hop nhat (ghi ro de tranh mat diem): XP lay max(server, client);
  // coins lay theo client (client la noi duy nhat tru coins khi mua do; thuong
  // diem danh/dau truong tu server da duoc client ap dung truoc khi sync);
  // streak/checkedDay do server nam (checkin) nen sync KHONG ghi de chung.
  if (url.pathname === '/api/sync') {
    const st = asObject(body.state);
    const xp = Math.max(me.xp, clampInt(st.xp, 0, 990000, me.xp));
    const coins = clampInt(st.coins, 0, 1000000, me.coins);
    const wins = clampInt(st.wins, 0, 100000, me.wins);
    const merged = {
      quizPassed: asStringArray(st.quizPassed, 100),
      quizDoneIds: asStringArray(st.quizDoneIds, 10000),
      inboxPaid: asStringArray(st.inboxPaid, 100),
      linkPaidDay: typeof st.linkPaidDay === 'string' ? st.linkPaidDay.slice(0, 10) : '',
      owned: asStringArray(st.owned, 100),
      equipped: asObject(st.equipped),
      threads: asObject(st.threads),
      unread: asObject(st.unread),
    };
    store.updatePlayer(me.key, { xp, coins, wins, state_json: JSON.stringify(merged), last_seen_at: nowISO() });
    return sendJson(res, 200, { ok: true, xp, coins, wins });
  }

  // POST /api/messages/send — nhan tin rieng cho mot nguoi choi khac.
  if (url.pathname === '/api/messages/send') {
    const toKey = normKey(body.to); const text = String(body.body || '').trim();
    if (!text || text.length > 500) return sendJson(res, 400, { ok: false, error: 'Tin nhan can 1-500 ky tu.' });
    if (toKey === me.key) return sendJson(res, 400, { ok: false, error: 'Khong gui tin cho chinh minh.' });
    const to = store.getPlayerByKey(toKey);
    if (!to) return sendJson(res, 404, { ok: false, error: 'Khong tim thay nguoi nhan.' });
    const id = store.insertMessage(me.key, to.key, text);
    return sendJson(res, 200, { ok: true, id });
  }
  // GET /api/messages?token=...&with=TEN — lay hoi thoai 2 chieu, danh dau da doc.
  if (url.pathname === '/api/messages' && req.method === 'GET') {
    const withKey = normKey(url.searchParams.get('with') || '');
    const partner = store.getPlayerByKey(withKey);
    if (!partner) return sendJson(res, 404, { ok: false, error: 'Khong tim thay nguoi nay.' });
    const rows = store.thread(me.key, withKey).map((m) => ({
      id: m.id, mine: m.from_key === me.key, body: m.body, at: Date.parse(m.created_at),
    }));
    store.markRead(me.key, withKey);
    return sendJson(res, 200, { ok: true, messages: rows });
  }

  // --- Dau truong truc tiep 2 nguoi (polling, khong can WebSocket) ---
  // POST /api/arena/quickmatch — vao hang cho; neu co nguoi dang cho thi ghep ngay.
  if (url.pathname === '/api/arena/quickmatch') {
    const open = store.findOpenMatchFor(me.key);
    if (open) return sendJson(res, 200, { ok: true, match: matchView(open, me.key) });
    const waiting = store.findWaitingMatch(me.key);
    if (waiting) { store.joinMatch(waiting.id, me.key); return sendJson(res, 200, { ok: true, match: matchView(store.getMatch(waiting.id), me.key) }); }
    const m = store.createMatch(me.key);
    return sendJson(res, 200, { ok: true, match: matchView(m, me.key), waiting: true });
  }
  // POST /api/arena/status — client hoi moi 2-3 giay khi dang cho/dau.
  if (url.pathname === '/api/arena/status') {
    const m = store.getMatch(body.matchId) || store.findOpenMatchFor(me.key);
    if (!m) return sendJson(res, 200, { ok: true, match: null });
    return sendJson(res, 200, { ok: true, match: matchView(m, me.key) });
  }
  // POST /api/arena/submit-round {matchId, roundNo, kind, score}
  // The thang: Quiz – Race – Quiz, thang 2/3 luot. Thang tran: +30 XP/+25 coins/+1 win;
  // thua: +8 XP/+5 coins; hoa: +12 XP/+10 coins (giong ban tinh dau Bot).
  if (url.pathname === '/api/arena/submit-round') {
    const m = store.getMatch(body.matchId);
    if (!m || m.status !== 'playing') return sendJson(res, 400, { ok: false, error: 'Tran dau khong con hieu luc.' });
    const side = m.a_key === me.key ? 'a' : (m.b_key === me.key ? 'b' : null);
    if (!side) return sendJson(res, 403, { ok: false, error: 'Ban khong o trong tran nay.' });
    const roundNo = clampInt(body.roundNo, 1, 3, m.round_no);
    const kind = roundNo === 2 ? 'race' : 'quiz';
    const score = clampInt(body.score, 0, 100000, 0);
    const round = store.upsertRound(m.id, roundNo, kind, side, score);
    let view = matchView(store.getMatch(m.id), me.key);
    if (round.a_score != null && round.b_score != null) {
      const cur = store.getMatch(m.id);
      let aWins = cur.a_wins; let bWins = cur.b_wins;
      if (round.a_score > round.b_score) aWins++;
      else if (round.b_score > round.a_score) bWins++;
      // Hoa: khong ai duoc luot thang, van sang luot sau.
      let status = cur.status; let nextRound = cur.round_no;
      if (aWins >= 2 || bWins >= 2 || roundNo >= 3) status = 'finished';
      else nextRound = roundNo + 1;
      store.updateMatch(m.id, { a_wins: aWins, b_wins: bWins, round_no: nextRound, status });
      if (status === 'finished' && !cur.awarded) {
        store.updateMatch(m.id, { awarded: 1 });
        awardArenaResult(store.getMatch(m.id));
      }
      view = matchView(store.getMatch(m.id), me.key);
    }
    return sendJson(res, 200, { ok: true, match: view });
  }
  // POST /api/arena/forfeit {matchId}
  if (url.pathname === '/api/arena/forfeit') {
    const m = store.getMatch(body.matchId);
    if (!m || m.status !== 'playing') return sendJson(res, 400, { ok: false, error: 'Tran dau khong con hieu luc.' });
    const side = m.a_key === me.key ? 'a' : (m.b_key === me.key ? 'b' : null);
    if (!side) return sendJson(res, 403, { ok: false, error: 'Ban khong o trong tran nay.' });
    const finished = { ...m, a_wins: side === 'a' ? m.a_wins : 2, b_wins: side === 'b' ? m.b_wins : 2, status: 'finished' };
    store.updateMatch(m.id, { a_wins: finished.a_wins, b_wins: finished.b_wins, status: 'finished' });
    if (!m.awarded) { store.updateMatch(m.id, { awarded: 1 }); awardArenaResult(store.getMatch(m.id)); }
    return sendJson(res, 200, { ok: true, match: matchView(store.getMatch(m.id), me.key) });
  }

  return sendJson(res, 404, { ok: false, error: 'Khong co API nay.' });
}

function matchView(m, myKey) {
  if (!m) return null;
  const rounds = store.listRounds(m.id).map((r) => ({ roundNo: r.round_no, kind: r.kind, aScore: r.a_score, bScore: r.b_score }));
  const a = store.getPlayerByKey(m.a_key); const b = m.b_key ? store.getPlayerByKey(m.b_key) : null;
  const iAmA = m.a_key === myKey;
  const meP = iAmA ? a : b; const opP = iAmA ? b : a;
  return { id: m.id, status: m.status, roundNo: m.round_no,
    opponent: opP ? publicPlayer(opP, Date.now()) : null,
    me: meP ? publicPlayer(meP, Date.now()) : null,
    myWins: iAmA ? m.a_wins : m.b_wins, opWins: iAmA ? m.b_wins : m.a_wins,
    rounds: rounds.map((r) => ({ roundNo: r.roundNo, kind: r.kind,
      myScore: iAmA ? r.aScore : r.bScore, opScore: iAmA ? r.bScore : r.aScore })) };
}
function awardArenaResult(m) {
  const a = store.getPlayerByKey(m.a_key); const b = m.b_key ? store.getPlayerByKey(m.b_key) : null;
  if (!a || !b) return;
  const apply = (p, xp, coins, win) => {
    if (p.is_showcase) return; // nguoi mau khong nhan thuong that
    store.updatePlayer(p.key, { xp: p.xp + xp, coins: p.coins + coins, wins: p.wins + (win ? 1 : 0) });
  };
  if (m.a_wins > m.b_wins) { apply(a, 30, 25, true); apply(b, 8, 5, false); }
  else if (m.b_wins > m.a_wins) { apply(b, 30, 25, true); apply(a, 8, 5, false); }
  else { apply(a, 12, 10, false); apply(b, 12, 10, false); }
}

/* ================= HTTP SERVER ================= */
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const SYNC_JS = fs.readFileSync(path.join(__dirname, 'public', 'sync.js'), 'utf8');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/') {
      // Chen sync.js vao cuoi body: file goc giu nguyen, server tu gan lop dong bo.
      const html = INDEX_HTML.replace('</body>', '<script src="/sync.js"></script>\n</body>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      return res.end(html);
    }
    if (url.pathname === '/sync.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': Buffer.byteLength(SYNC_JS) });
      return res.end(SYNC_JS);
    }
    if (url.pathname.startsWith('/api/')) {
      // GET /api/messages la GET co query token; cac API GET khac khong can body.
      if (url.pathname === '/api/messages' && req.method === 'GET') {
        const token = url.searchParams.get('token') || '';
        const sess = store.getSession(token);
        if (!sess) return sendJson(res, 401, { ok: false, error: 'Phien dang nhap het han, hay dang nhap lai.' });
        const me = store.getPlayerById(sess.player_id);
        store.touchSession(token); store.touchPlayer(me.key);
        const withKey = normKey(url.searchParams.get('with') || '');
        const partner = store.getPlayerByKey(withKey);
        if (!partner) return sendJson(res, 404, { ok: false, error: 'Khong tim thay nguoi nay.' });
        const rows = store.thread(me.key, withKey).map((m) => ({ id: m.id, mine: m.from_key === me.key, body: m.body, at: Date.parse(m.created_at) }));
        store.markRead(me.key, withKey);
        return sendJson(res, 200, { ok: true, messages: rows });
      }
      return await handleApi(req, res, url);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Khong tim thay trang.');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Loi may chu, thu lai sau.' });
  }
});

server.listen(PORT, () => {
  console.log(`ScamBuster server chay tai http://localhost:${PORT} (store=${STORE_KIND}, version ${VERSION})`);
  console.log(`Kiem tra: curl http://localhost:${PORT}/api/health`);
});

'use strict';
/**
 * test-pgmem.js — kiem thu duong Postgres cua ScamBuster bang pg-mem
 * (bo gia lap Postgres trong bo nho, KHONG phai Postgres that).
 *
 * Cach dung: npm run test-pgmem   (hoac: node test-pgmem.js)
 *  - Tao PostgresStore tren Pool cua pg-mem, seed 20 nguoi mau.
 *  - Gan store do vao HTTP server that (server.js) roi chay toan bo
 *    luong API nhu test-smoke.sh: register/login/check-in/sync/state/
 *    messages/arena/CSV/heartbeat/health.
 *  - In PASS/FAIL tung case, thoat 0 neu tat ca dat.
 *
 * GIOI HAN NOI RO: pg-mem chi mo phong Postgres. No dat khong co nghia
 * Neon Postgres that se dat 100% — truoc khi gui link cho hoc sinh, van
 * phai chay lai test-smoke.sh tren link Render sau khi dat DATABASE_URL.
 */
const { newDb } = require('pg-mem');
const { PostgresStore, server, setStore } = require('./server.js');

const PORT = Number(process.env.PG_TEST_PORT || 3002);
const BASE = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
async function j(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}
async function get(path) { return (await fetch(BASE + path)).json(); }
async function getText(path) { return (await fetch(BASE + path)).text(); }

async function main() {
  const db = newDb();
  // pg-mem: ham NOW() mac dinh tra thoi gian that; can dang ky ham phu neu thieu.
  db.public.registerFunction({ name: 'now', args: [], returns: 'timestamp', implementation: () => new Date() });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const store = new PostgresStore(pool);
  await store.init();
  check('PostgresStore init + seed 20 nguoi mau', (await store.listPlayers()).length === 20);

  setStore(store, 'postgres');
  await new Promise((resolve) => server.listen(PORT, resolve));

  try {
    const health = await get('/api/health');
    check('health store=postgres, version 1.1.0', health.ok && health.store === 'postgres' && health.version === '1.1.0', JSON.stringify(health));
    check('health dem 20 nguoi choi', health.players === 20);

    const state0 = await get('/api/state');
    check('state cong khai co 20 nguoi mau', state0.ok && state0.totalPlayers === 20 && state0.players.some((p) => p.name === 'Tuấn Anh'));

    const reg = await j('/api/register', { name: 'Quyên Lê', pass: '123456', gender: 'female' });
    check('register Quyen Le', reg.ok && !!reg.token, JSON.stringify(reg));
    const token = reg.token || '';
    const reg2 = await j('/api/register', { name: 'Minh Anh', pass: '123456', gender: 'male' });
    const token2 = reg2.token || '';
    check('register Minh Anh', reg2.ok && !!token2);

    const dup = await j('/api/register', { name: 'quyên   lê', pass: '123456', gender: 'female' });
    check('dang ky trung ten (chuan hoa) bi chan', !dup.ok && /da co nguoi dung/.test(dup.error || ''));
    const bad = await j('/api/login', { name: 'Quyên Lê', pass: 'sai' });
    check('sai mat khau bi chan', !bad.ok && /Mat khau chua dung/.test(bad.error || ''));
    const login = await j('/api/login', { name: 'Quyên Lê', pass: '123456' });
    check('login dung mat khau (doi may)', login.ok && login.player && login.player.name === 'Quyên Lê');

    const state1 = await get('/api/state');
    check('state thay ca 2 tai khoan that (tong 22)', state1.totalPlayers === 22 && state1.players.some((p) => p.name === 'Minh Anh'), JSON.stringify(state1.totalPlayers));

    const ck1 = await j('/api/checkin', { token });
    check('check-in lan dau = Ngay 1 (+15 coins, +5 XP)', ck1.ok && ck1.streak === 1 && ck1.xp === 5 && ck1.coins === 15, JSON.stringify(ck1));
    const ck2 = await j('/api/checkin', { token });
    check('check-in lan 2 cung ngay bi chan', ck2.ok && ck2.already === true);

    const sync = await j('/api/sync', { token, state: { xp: 120, coins: 40, wins: 2, owned: ['visor'], equipped: { 'phu-kien': 'visor' }, quizPassed: ['Tin nhắn'], quizDoneIds: [1, 2], threads: {}, unread: {} } });
    check('sync XP/coins/kho do', sync.ok && sync.xp === 120 && sync.coins === 40, JSON.stringify(sync));
    const me = await j('/api/me', { token });
    check('/api/me tra dung tien trinh', me.ok && me.player && (me.player.owned || []).includes('visor') && me.player.xp === 120, JSON.stringify(me.player && me.player.xp));

    const msg = await j('/api/messages/send', { token, to: 'Minh Anh', body: 'Chao ban, cung dau khong?' });
    check('gui tin nhan rieng', msg.ok && !!msg.id, JSON.stringify(msg));
    const thread = await get(`/api/messages?token=${encodeURIComponent(token2)}&with=${encodeURIComponent('Quyên Lê')}`);
    check('nguoi nhan doc duoc tin', thread.ok && thread.messages.some((m) => m.body.includes('Chao ban')), JSON.stringify(thread));

    const qm1 = await j('/api/arena/quickmatch', { token });
    const mid = qm1.match && qm1.match.id;
    check('quickmatch nguoi 1 cho', qm1.ok && !!mid && qm1.waiting === true, JSON.stringify(qm1));
    const qm2 = await j('/api/arena/quickmatch', { token: token2 });
    check('ghep dau truc tiep 2 nguoi', qm2.ok && qm2.match && qm2.match.status === 'playing', JSON.stringify(qm2));
    for (const r of [1, 2]) {
      await j('/api/arena/submit-round', { token, matchId: mid, roundNo: r, score: 900 });
      await j('/api/arena/submit-round', { token: token2, matchId: mid, roundNo: r, score: 500 });
    }
    const fin = await j('/api/arena/status', { token, matchId: mid });
    check('dau Quiz-Race thang 2/3 luot, ket thuc', fin.ok && fin.match && fin.match.status === 'finished' && fin.match.myWins === 2, JSON.stringify(fin.match));
    const meAfter = await j('/api/me', { token });
    check('thuong PvP cong XP cho nguoi thang', meAfter.ok && meAfter.player.xp >= 120 + 30, `xp=${meAfter.player && meAfter.player.xp}`);

    const csv = await getText('/api/players.csv');
    check('xuat CSV an danh cho giao vien', csv.includes('Quyên Lê') && csv.includes('name,gender,level'));
    const hb = await j('/api/heartbeat', { token });
    check('heartbeat', hb.ok === true);
    const health2 = await get('/api/health');
    check('sau tran dau van store=postgres, 22 nguoi', health2.store === 'postgres' && health2.players === 22);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  }
  console.log(`\nKet qua Postgres (pg-mem): ${pass} PASS, ${fail} FAIL`);
  if (fail) { console.log('CO TEST FAIL'); process.exit(1); }
  console.log('TAT CA TEST POSTGRES (pg-mem) DAT');
}

main().catch((e) => { console.error('LOI TEST:', e); process.exit(1); });

import assert from 'node:assert/strict';
import { handle } from '../netlify/functions/lib/core.mjs';
import { QUESTIONS } from '../netlify/functions/lib/questions.mjs';
import { memStore } from './memstore.mjs';
const store = memStore(); let now = Date.parse('2027-03-01T09:00:00+07:00');
const env = {}; // ใช้รหัสผ่านเริ่มต้นและกุญแจที่เก็บใน Blobs
async function call(path, body, method = 'POST', token) {
  const req = new Request('https://x/api/' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  const r = await handle(req, { store, now, env, ip: '1.2.3.4' }); return { s: r.status, j: await r.json() };
}
let r;
// closed
r = await call('start', { sid: '6612345678', name: 'นายทดสอบ หนึ่ง', section: 'พล.3/1', deviceId: 'd1' }); assert.equal(r.s, 403);
// admin
assert.equal((await call('admin/login', { password: 'x' })).s, 401);
const tok = (await call('admin/login', { password: 'Yongyut032437' })).j.token;
r = await call('admin/config', { open: true, durationMin: 90, maxViolations: 3 }, 'POST', tok); assert.ok(r.j.ok);
// start
r = await call('start', { sid: '6612345678', name: 'นายทดสอบ หนึ่ง', section: 'พล.3/1', deviceId: 'd1' }); assert.equal(r.s, 200);
const A = r.j; assert.equal(A.questions.length, 60); assert.ok(!JSON.stringify(A).includes('"a":'));
// no answers leaked
assert.ok(A.questions.every(q => !('a' in q)));
// other device blocked
r = await call('start', { sid: '6612345678', name: 'นายทดสอบ หนึ่ง', section: 'พล.3/1', deviceId: 'd2' }); assert.equal(r.s, 423);
// name mismatch
r = await call('start', { sid: '6612345678', name: 'คนอื่น ปลอม', section: 'พล.3/1', deviceId: 'd1' }); assert.equal(r.s, 403);
// compute correct answers from server state (test only) -> answer all correctly
const att = await store.get('att/6612345678');
const tokenNow = att.token;
const ans = {}; att.order.forEach((qid, i) => { const q = QUESTIONS.find(x => x.id === qid); ans[i + 1] = att.perm[qid].indexOf(q.a); });
r = await call('save', { sid: '6612345678', token: tokenNow, answers: ans }); assert.equal(r.j.saved, 60);
// violations: two within gap count once
r = await call('event', { sid: '6612345678', token: tokenNow, type: 'leave' }); assert.equal(r.j.violations, 1);
r = await call('event', { sid: '6612345678', token: tokenNow, type: 'leave' }); assert.equal(r.j.violations, 1);
now += 3000; r = await call('event', { sid: '6612345678', token: tokenNow, type: 'devtools' }); assert.equal(r.j.violations, 1);
r = await call('submit', { sid: '6612345678', token: tokenNow, answers: ans }); assert.ok(r.j.ok); assert.ok(!('score' in r.j));
// cannot restart
r = await call('start', { sid: '6612345678', name: 'นายทดสอบ หนึ่ง', section: 'พล.3/1', deviceId: 'd1' }); assert.equal(r.s, 409);
// student 2: violations auto-submit
r = await call('start', { sid: '6600000002', name: 'นางสาวสอง ทดสอบ', section: 'พล.3/2', deviceId: 'x' }); const t2 = r.j.token;
await call('save', { sid: '6600000002', token: t2, answers: { 1: 0, 2: 1 } });
for (let i = 0; i < 3; i++) { now += 2500; r = await call('event', { sid: '6600000002', token: t2, type: 'fullscreen_exit' }); }
assert.ok(r.j.terminated);
// student 3: timeout via server
r = await call('start', { sid: '6600000003', name: 'นายสาม ทดสอบ', section: 'พล.3/3', deviceId: 'y' }); const t3 = r.j.token;
await call('save', { sid: '6600000003', token: t3, answers: { 1: 1 } });
now += 91 * 60000;
r = await call('save', { sid: '6600000003', token: t3, answers: { 1: 1, 2: 2 } }); assert.ok(r.j.submitted || r.s === 409);
// admin results
r = await call('admin/results', null, 'GET', tok);
const rows = Object.fromEntries(r.j.rows.map(x => [x.sid, x]));
assert.equal(rows['6612345678'].raw, 60); assert.equal(rows['6612345678'].score, 30);
assert.equal(rows['6600000002'].reason, 'violations'); assert.equal(rows['6600000003'].reason, 'timeout_server');
assert.equal(rows['6600000003'].answered, 1);
assert.ok(rows['6612345678'].flags.includes('device_mismatch'));
r = await call('admin/items', null, 'GET', tok); assert.equal(r.j.items.length, 60);
r = await call('admin/detail', { sid: '6612345678' }, 'POST', tok); assert.equal(r.j.items.length, 60);
// unlock + reset
r = await call('admin/reset', { sid: '6600000002' }, 'POST', tok); assert.ok(r.j.ok);
r = await call('start', { sid: '6600000002', name: 'นางสาวสอง ทดสอบ', section: 'พล.3/2', deviceId: 'x' }); assert.equal(r.s, 200);
r = await call('admin/extend', { sid: '6600000002', minutes: 10 }, 'POST', tok); assert.ok(r.j.ok);
// bad admin token
assert.equal((await call('admin/results', null, 'GET', 'bad.tok')).s, 401);
// closeAt caps deadline
await call('admin/config', { closeAt: new Date(now + 10 * 60000).toISOString() }, 'POST', tok);
r = await call('start', { sid: '6600000004', name: 'นายสี่ ทดสอบ', section: 'พล.3/4', deviceId: 'z' });
assert.ok(r.j.deadline <= now + 10 * 60000);
// ---- โหมดตามกำหนดเวลา ----
r = await call('admin/config', { mode: 'scheduled', openAt: null, closeAt: null }, 'POST', tok); assert.equal(r.s, 400);
const o = now + 60 * 60000, c = o + 120 * 60000;
r = await call('admin/config', { mode: 'scheduled', openAt: new Date(c).toISOString(), closeAt: new Date(o).toISOString() }, 'POST', tok); assert.equal(r.s, 400);
r = await call('admin/config', { mode: 'scheduled', openAt: new Date(o).toISOString(), closeAt: new Date(c).toISOString() }, 'POST', tok); assert.ok(r.j.ok);
r = await call('status', null, 'GET'); assert.equal(r.j.phase, 'before'); assert.ok(r.j.message.includes('2570'));
r = await call('start', { sid: '6600000010', name: 'นายสิบ ทดสอบ', section: 'พล.3/1', deviceId: 'q' }); assert.equal(r.s, 403);
now = o + 1000; r = await call('status', null, 'GET'); assert.equal(r.j.phase, 'open');
r = await call('start', { sid: '6600000010', name: 'นายสิบ ทดสอบ', section: 'พล.3/1', deviceId: 'q' }); assert.equal(r.s, 200);
assert.equal(r.j.deadline, o + 1000 + 90 * 60000);
// อาจารย์เลื่อนเวลาปิดให้เร็วขึ้น -> ผู้กำลังสอบถูกปรับเวลาสิ้นสุด
const c2 = now + 30 * 60000;
r = await call('admin/config', { closeAt: new Date(c2).toISOString() }, 'POST', tok); assert.ok(r.j.capped >= 1);
r = await call('save', { sid: '6600000010', token: (await store.get('att/6600000010')).token, answers: {} }); assert.equal(r.j.deadline, c2);
now = c2 + 31000; r = await call('status', null, 'GET'); assert.equal(r.j.phase, 'ended');
r = await call('admin/results', null, 'GET', tok); assert.equal(r.j.rows.find(x => x.sid === '6600000010').status, 'submitted');
r = await call('admin/config', { mode: 'closed' }, 'POST', tok); r = await call('status', null, 'GET'); assert.equal(r.j.phase, 'closed');
console.log('ALL TESTS PASSED');

// ตรรกะหลักของระบบสอบ (แยกจาก Netlify เพื่อให้ทดสอบได้)
// store: อ็อบเจกต์ที่มี get(key,{type:'json'}), setJSON(key,val), delete(key), list({prefix})
import crypto from 'node:crypto';
import { QUESTIONS, COURSE } from './questions.mjs';

const QMAP = Object.fromEntries(QUESTIONS.map(q => [q.id, q]));
const N = QUESTIONS.length;
const GRACE_MS = 30_000;            // เผื่อเวลาเครือข่ายหลังหมดเวลา
const COUNTED = new Set(['leave', 'fullscreen_exit', 'multi_tab']); // นับเป็นการทำผิด
const MIN_GAP_MS = 2_000;           // เหตุการณ์ที่นับซ้ำภายใน 2 วินาทีถือเป็นครั้งเดียว
const MAX_LOG = 300;

export const DEFAULT_CONFIG = {
  mode: 'closed',        // 'closed' = ปิด, 'open' = เปิดทันที, 'scheduled' = เปิด-ปิดตามวันเวลาที่กำหนด
  openAt: null,          // ISO วันเวลาเปิดสอบ
  closeAt: null,         // ISO วันเวลาปิดสอบ (ทุกคนต้องส่งไม่เกินเวลานี้)
  durationMin: 90,
  maxViolations: 3,
  sections: ['พล.3/1', 'พล.3/2', 'พล.3/3', 'พล.3/4', 'พล.3/5'],
  showScore: false,
};

// ---------- utilities ----------
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const err = (status, code, message) => json({ ok: false, code, message }, status);
const rnd = (n = 24) => crypto.randomBytes(n).toString('hex');
const normName = s => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
const normSid = s => String(s || '').replace(/\s+/g, '').trim();
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// รหัสผ่านผู้ดูแลเริ่มต้น (เก็บเป็นค่า SHA-256 ไม่ใช่ตัวรหัสจริง) ตั้ง ADMIN_PASSWORD ใน Netlify เพื่อเปลี่ยนรหัสได้
const ADMIN_HASH = '3ddbaf3bf3b7f31d6fd9ba5b7cd3d412b54513457743a8a867246af09df835fa';
function checkPassword(pw, env) {
  if (env.ADMIN_PASSWORD) return safeEq(pw, env.ADMIN_PASSWORD);
  return safeEq(NC_hash(pw), ADMIN_HASH);
}
function NC_hash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
// กุญแจเซ็นสิทธิ์ผู้ดูแล: ใช้ TOKEN_SECRET ถ้าตั้งไว้ ไม่เช่นนั้นสุ่มครั้งแรกแล้วเก็บใน Blobs (ไม่อยู่ใน GitHub)
async function getSecret(ctx) {
  if (ctx.env.TOKEN_SECRET) return ctx.env.TOKEN_SECRET;
  if (ctx._secret) return ctx._secret;
  let rec = await ctx.store.get('sys/secret', { type: 'json' });
  if (!rec) { rec = { k: rnd(32) }; await ctx.store.setJSON('sys/secret', rec); }
  return (ctx._secret = rec.k);
}
function sign(payload, key) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token, key) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const exp = crypto.createHmac('sha256', key).update(body).digest('base64url');
  if (!safeEq(mac, exp)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
async function body(req) { try { return await req.json(); } catch { return {}; } }

// ---------- storage keys ----------
const K = { config: 'config', att: sid => 'att/' + sid, ans: sid => 'ans/' + sid };
async function getConfig(store) { return { ...DEFAULT_CONFIG, ...((await store.get(K.config, { type: 'json' })) || {}) }; }

function cfgMode(cfg) { return cfg.mode || (cfg.open ? 'open' : 'closed'); }
const TH = iso => new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'full', timeStyle: 'short' }) + ' น.';
// สถานะการสอบ ณ เวลาปัจจุบัน: closed | before | open | ended
function examWindow(cfg, now) {
  const mode = cfgMode(cfg);
  const o = cfg.openAt ? Date.parse(cfg.openAt) : null, c = cfg.closeAt ? Date.parse(cfg.closeAt) : null;
  if (mode === 'closed') return { ok: false, phase: 'closed', message: 'ขณะนี้ยังไม่เปิดให้เข้าสอบ' };
  if (mode === 'scheduled') {
    if (!o || !c) return { ok: false, phase: 'closed', message: 'ขณะนี้ยังไม่เปิดให้เข้าสอบ' };
    if (now < o) return { ok: false, phase: 'before', message: 'เปิดให้เข้าสอบ ' + TH(cfg.openAt) };
  }
  if (c && now >= c) return { ok: false, phase: 'ended', message: 'หมดเวลาการสอบแล้ว (ปิดเมื่อ ' + TH(cfg.closeAt) + ')' };
  return { ok: true, phase: 'open' };
}

// ---------- grading ----------
export function grade(att, answers) {
  let raw = 0; const items = [];
  att.order.forEach((qid, idx) => {
    const n = idx + 1, q = QMAP[qid];
    const shown = answers?.[n];
    const orig = (shown === 0 || shown) ? att.perm[qid][shown] : null;
    const correct = orig !== null && orig === q.a;
    if (correct) raw++;
    items.push({ qid, n, chosen: orig, correct });
  });
  const score = Math.round((raw * COURSE.fullScore / N) * 100) / 100;
  return { raw, total: N, score, items };
}

function publicQuestions(att) {
  return att.order.map((qid, idx) => ({ n: idx + 1, text: QMAP[qid].q, choices: att.perm[qid].map(i => QMAP[qid].o[i]) }));
}

async function finalize(store, att, reason, now, answersIn) {
  if (att.status === 'submitted') return att;
  const ansRec = (await store.get(K.ans(att.sid), { type: 'json' })) || { answers: {} };
  const answers = answersIn ? { ...ansRec.answers, ...answersIn } : ansRec.answers;
  const g = grade(att, answers);
  att.status = 'submitted';
  att.reason = reason;
  att.submittedAt = new Date(now).toISOString();
  att.result = g;
  att.answered = Object.keys(answers).length;
  att.log.push({ t: att.submittedAt, type: 'submit', detail: reason });
  await store.setJSON(K.ans(att.sid), { answers, savedAt: att.submittedAt });
  await store.setJSON(K.att(att.sid), att);
  return att;
}

// ปิดชุดที่หมดเวลาแล้วฝั่งเซิร์ฟเวอร์ (กันกรณีปิดเครื่องหนี)
async function autoExpire(store, att, now) {
  if (att.status === 'in_progress' && now > att.deadline + GRACE_MS) await finalize(store, att, 'timeout_server', now);
  return att;
}

async function attByToken(store, b, now) {
  const sid = normSid(b.sid);
  if (!sid || !b.token) return { e: err(401, 'auth', 'ข้อมูลการเข้าสอบไม่ถูกต้อง') };
  const att = await store.get(K.att(sid), { type: 'json' });
  if (!att || !safeEq(att.token, b.token)) return { e: err(401, 'auth', 'สิทธิ์การสอบไม่ถูกต้องหรือหมดอายุ') };
  await autoExpire(store, att, now);
  return { att };
}

function clampAnswers(a) {
  const out = {};
  if (a && typeof a === 'object') for (const [k, v] of Object.entries(a)) {
    const n = Number(k), c = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= N && Number.isInteger(c) && c >= 0 && c <= 3) out[n] = c;
  }
  return out;
}

// ---------- student endpoints ----------
async function start(req, ctx) {
  const { store, now } = ctx; const b = await body(req);
  const cfg = await getConfig(store);
  const sid = normSid(b.sid), name = normName(b.name), section = normName(b.section);
  const deviceId = String(b.deviceId || '').slice(0, 64);
  if (!/^[0-9A-Za-z-]{5,15}$/.test(sid)) return err(400, 'sid', 'รหัสนักศึกษาไม่ถูกต้อง (ตัวเลข 5–15 หลัก)');
  if (name.length < 4 || name.length > 80) return err(400, 'name', 'กรุณากรอกชื่อ-สกุลให้ครบถ้วน');
  if (cfg.sections?.length && !cfg.sections.includes(section)) return err(400, 'section', 'กรุณาเลือกหมู่เรียน');
  if (!deviceId) return err(400, 'device', 'เบราว์เซอร์ไม่รองรับ');

  let att = await store.get(K.att(sid), { type: 'json' });
  if (att) {
    await autoExpire(store, att, now);
    if (att.status === 'submitted') return err(409, 'submitted', 'รหัสนักศึกษานี้ส่งคำตอบแล้ว ไม่สามารถสอบซ้ำได้');
    if (att.name !== name) {
      att.log.push({ t: new Date(now).toISOString(), type: 'name_mismatch', detail: name.slice(0, 80) });
      await store.setJSON(K.att(sid), att);
      return err(403, 'name', 'ชื่อ-สกุลไม่ตรงกับที่ลงทะเบียนเข้าสอบไว้ กรุณาติดต่ออาจารย์ผู้คุมสอบ');
    }
    if (att.deviceId && att.deviceId !== deviceId) {
      att.log.push({ t: new Date(now).toISOString(), type: 'device_mismatch', detail: ctx.ip || '' });
      await store.setJSON(K.att(sid), att);
      return err(423, 'device', 'รหัสนี้กำลังสอบอยู่บนอุปกรณ์อื่น กรุณาติดต่ออาจารย์ผู้คุมสอบเพื่อปลดล็อก');
    }
    // กลับเข้าสอบต่อ (เช่น เบราว์เซอร์ค้าง) — เวลายังเดินต่อ
    att.deviceId = deviceId; att.resumes = (att.resumes || 0) + 1;
    att.log.push({ t: new Date(now).toISOString(), type: 'resume', detail: ctx.ip || '' });
    att.token = rnd();
    await store.setJSON(K.att(sid), att);
  } else {
    const w = examWindow(cfg, now);
    if (!w.ok) return err(403, 'closed', w.message);
    const order = shuffle(QUESTIONS.map(q => q.id));
    const perm = Object.fromEntries(QUESTIONS.map(q => [q.id, shuffle([0, 1, 2, 3])]));
    let deadline = now + cfg.durationMin * 60_000;
    if (cfg.closeAt) deadline = Math.min(deadline, Date.parse(cfg.closeAt));
    att = {
      sid, name, section, deviceId, token: rnd(), order, perm,
      startedAt: new Date(now).toISOString(), deadline, status: 'in_progress',
      violations: 0, lastCountedAt: 0, resumes: 0, ip: ctx.ip || '', ua: String(req.headers.get('user-agent') || '').slice(0, 200),
      log: [{ t: new Date(now).toISOString(), type: 'start', detail: ctx.ip || '' }],
    };
    await store.setJSON(K.att(sid), att);
    await store.setJSON(K.ans(sid), { answers: {}, savedAt: null });
  }
  const ansRec = (await store.get(K.ans(sid), { type: 'json' })) || { answers: {} };
  return json({
    ok: true, token: att.token, sid, name: att.name, section: att.section, course: COURSE,
    serverNow: now, deadline: att.deadline, violations: att.violations, maxViolations: cfg.maxViolations,
    questions: publicQuestions(att), answers: ansRec.answers,
  });
}

async function save(req, ctx) {
  const { store, now } = ctx; const b = await body(req);
  const { att, e } = await attByToken(store, b, now); if (e) return e;
  if (att.status === 'submitted') return json({ ok: true, submitted: true, serverNow: now });
  if (now > att.deadline + GRACE_MS) return json({ ok: false, code: 'timeout', message: 'หมดเวลาแล้ว', serverNow: now }, 409);
  const answers = clampAnswers(b.answers);
  await store.setJSON(K.ans(att.sid), { answers, savedAt: new Date(now).toISOString() });
  return json({ ok: true, saved: Object.keys(answers).length, serverNow: now, deadline: att.deadline });
}

async function event(req, ctx) {
  const { store, now } = ctx; const b = await body(req);
  const { att, e } = await attByToken(store, b, now); if (e) return e;
  if (att.status === 'submitted') return json({ ok: true, submitted: true });
  const cfg = await getConfig(store);
  const type = String(b.type || '').slice(0, 30), detail = String(b.detail || '').slice(0, 120);
  let counted = false;
  if (COUNTED.has(type) && now - (att.lastCountedAt || 0) > MIN_GAP_MS) {
    att.violations++; att.lastCountedAt = now; counted = true;
  }
  att.log.push({ t: new Date(now).toISOString(), type, detail, counted });
  if (att.log.length > MAX_LOG) att.log = att.log.slice(-MAX_LOG);
  if (att.violations >= cfg.maxViolations) {
    await finalize(store, att, 'violations', now, clampAnswers(b.answers));
    return json({ ok: true, terminated: true, violations: att.violations, maxViolations: cfg.maxViolations });
  }
  await store.setJSON(K.att(att.sid), att);
  return json({ ok: true, counted, violations: att.violations, maxViolations: cfg.maxViolations });
}

async function submit(req, ctx) {
  const { store, now } = ctx; const b = await body(req);
  const { att, e } = await attByToken(store, b, now); if (e) return e;
  const cfg = await getConfig(store);
  if (att.status !== 'submitted') {
    const late = now > att.deadline + GRACE_MS;
    // ส่งช้าเกินเวลาที่กำหนด: ใช้เฉพาะคำตอบที่บันทึกไว้ก่อนหมดเวลา
    await finalize(store, att, b.reason === 'timeout' ? 'timeout' : (late ? 'timeout_late' : 'manual'), now, late ? null : clampAnswers(b.answers));
  }
  const res = { ok: true, submittedAt: att.submittedAt, answered: att.answered, total: N };
  if (cfg.showScore) Object.assign(res, { raw: att.result.raw, score: att.result.score });
  return json(res);
}

async function status(req, ctx) {
  const cfg = await getConfig(ctx.store);
  const w = examWindow(cfg, ctx.now);
  return json({ ok: true, open: w.ok, phase: w.phase, message: w.message || '', mode: cfgMode(cfg), openAt: cfg.openAt, closeAt: cfg.closeAt, sections: cfg.sections, durationMin: cfg.durationMin, maxViolations: cfg.maxViolations, total: N, course: COURSE, serverNow: ctx.now });
}

// ---------- admin ----------
async function adminLogin(req, ctx) {
  const b = await body(req);
  if (!checkPassword(String(b.password || ''), ctx.env)) {
    await new Promise(r => setTimeout(r, 800));
    return err(401, 'auth', 'รหัสผ่านไม่ถูกต้อง');
  }
  return json({ ok: true, token: sign({ role: 'admin', exp: Date.now() + 12 * 3600_000 }, await getSecret(ctx)) });
}

async function listAll(store, now) {
  const { blobs } = await store.list({ prefix: 'att/' });
  const out = [];
  for (const { key } of blobs) {
    const att = await store.get(key, { type: 'json' });
    if (att) { await autoExpire(store, att, now); out.push(att); }
  }
  return out;
}

function summary(a, now) {
  return {
    sid: a.sid, name: a.name, section: a.section, status: a.status, reason: a.reason || '',
    startedAt: a.startedAt, submittedAt: a.submittedAt || null, deadline: a.deadline,
    remainingSec: a.status === 'in_progress' ? Math.max(0, Math.round((a.deadline - now) / 1000)) : 0,
    raw: a.result?.raw ?? null, score: a.result?.score ?? null, answered: a.answered ?? null,
    violations: a.violations, resumes: a.resumes || 0, ip: a.ip || '',
    flags: [...new Set(a.log.filter(l => ['device_mismatch', 'name_mismatch', 'devtools', 'printscreen', 'multi_tab'].includes(l.type)).map(l => l.type))],
  };
}

function itemAnalysis(atts) {
  const done = atts.filter(a => a.status === 'submitted' && a.result);
  const n = done.length;
  const sorted = done.slice().sort((x, y) => y.result.raw - x.result.raw);
  const g = Math.max(1, Math.round(n * 0.27));
  const hi = sorted.slice(0, g), lo = sorted.slice(-g);
  const correctOf = (a, qid) => a.result.items.find(i => i.qid === qid)?.correct;
  return QUESTIONS.map((q, i) => {
    const right = done.filter(a => correctOf(a, q.id)).length;
    const choiceCount = [0, 0, 0, 0, 0];
    done.forEach(a => { const it = a.result.items.find(x => x.qid === q.id); choiceCount[it?.chosen ?? 4]++; });
    const pH = hi.filter(a => correctOf(a, q.id)).length / g, pL = lo.filter(a => correctOf(a, q.id)).length / g;
    return { no: i + 1, qid: q.id, ch: q.ch, text: q.q, key: q.a, n, p: n ? +(right / n).toFixed(2) : null, r: n >= 4 ? +(pH - pL).toFixed(2) : null, choices: choiceCount };
  });
}

async function admin(req, ctx, action) {
  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!verify(auth, await getSecret(ctx))) return err(401, 'auth', 'กรุณาเข้าสู่ระบบใหม่');
  const { store, now } = ctx; const b = req.method === 'POST' ? await body(req) : {};
  const sid = normSid(b.sid);
  switch (action) {
    case 'config': {
      if (req.method === 'GET') { const c = await getConfig(store); c.mode = cfgMode(c); delete c.open; return json({ ok: true, config: c, window: examWindow(c, now), serverNow: now }); }
      const cur = await getConfig(store);
      const next = { ...cur };
      if ('mode' in b && ['closed', 'open', 'scheduled'].includes(b.mode)) next.mode = b.mode;
      else if ('open' in b) next.mode = b.open ? 'open' : 'closed';
      delete next.open;
      const toIso = v => { if (!v) return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : undefined; };
      if ('openAt' in b) { const v = toIso(b.openAt); if (v === undefined) return err(400, 'date', 'วันเวลาเปิดสอบไม่ถูกต้อง'); next.openAt = v; }
      if ('closeAt' in b) { const v = toIso(b.closeAt); if (v === undefined) return err(400, 'date', 'วันเวลาปิดสอบไม่ถูกต้อง'); next.closeAt = v; }
      if (next.mode === 'scheduled') {
        if (!next.openAt || !next.closeAt) return err(400, 'date', 'โหมดตามกำหนดเวลา ต้องระบุทั้งวันเวลาเปิดและปิด');
        if (Date.parse(next.closeAt) <= Date.parse(next.openAt)) return err(400, 'date', 'วันเวลาปิดต้องอยู่หลังวันเวลาเปิด');
      }
      if ('durationMin' in b) next.durationMin = Math.min(300, Math.max(5, Number(b.durationMin) || 90));
      if ('maxViolations' in b) next.maxViolations = Math.min(20, Math.max(1, Number(b.maxViolations) || 3));
      if ('showScore' in b) next.showScore = !!b.showScore;
      if (Array.isArray(b.sections)) next.sections = b.sections.map(normName).filter(Boolean).slice(0, 30);
      await store.setJSON(K.config, next);
      // ถ้าเลื่อนเวลาปิดให้เร็วขึ้น ปรับเวลาสิ้นสุดของผู้ที่กำลังสอบให้ไม่เกินเวลาปิด
      let capped = 0;
      if (next.closeAt && next.mode !== 'closed') {
        const c = Date.parse(next.closeAt);
        for (const a of await listAll(store, now)) {
          if (a.status === 'in_progress' && a.deadline > c) { a.deadline = c; a.log.push({ t: new Date(now).toISOString(), type: 'admin_close_time', detail: TH(next.closeAt) }); await store.setJSON(K.att(a.sid), a); capped++; }
        }
      }
      return json({ ok: true, config: next, capped, window: examWindow(next, now) });
    }
    case 'results': {
      const atts = await listAll(store, now);
      return json({ ok: true, serverNow: now, total: N, rows: atts.map(a => summary(a, now)) });
    }
    case 'detail': {
      const att = await store.get(K.att(sid), { type: 'json' });
      if (!att) return err(404, 'nf', 'ไม่พบข้อมูล');
      const ans = (await store.get(K.ans(sid), { type: 'json' })) || { answers: {} };
      const NO = Object.fromEntries(QUESTIONS.map((q, i) => [q.id, i + 1]));
      const items = (att.result || grade(att, ans.answers)).items.map(it => ({ ...it, no: NO[it.qid], ch: QMAP[it.qid].ch, key: QMAP[it.qid].a })).sort((a, b) => a.no - b.no);
      return json({ ok: true, summary: summary(att, now), items, log: att.log });
    }
    case 'items': return json({ ok: true, items: itemAnalysis(await listAll(store, now)) });
    case 'export': {
      const atts = await listAll(store, now);
      return json({ ok: true, rows: atts.map(a => ({ ...summary(a, now), items: a.result?.items?.map(i => ({ no: QUESTIONS.findIndex(q => q.id === i.qid) + 1, chosen: i.chosen, correct: i.correct })) || [] })) });
    }
    case 'unlock': case 'extend': case 'force': case 'reset': {
      const att = await store.get(K.att(sid), { type: 'json' });
      if (!att) return err(404, 'nf', 'ไม่พบข้อมูล');
      const t = new Date(now).toISOString();
      if (action === 'reset') { await store.delete(K.att(sid)); await store.delete(K.ans(sid)); return json({ ok: true }); }
      if (action === 'force') { await finalize(store, att, 'admin', now); return json({ ok: true }); }
      if (action === 'unlock') { att.deviceId = null; att.log.push({ t, type: 'admin_unlock' }); }
      if (action === 'extend') {
        const m = Math.min(120, Math.max(1, Number(b.minutes) || 5));
        if (att.status === 'submitted') return err(409, 'done', 'ส่งคำตอบแล้ว ต่อเวลาไม่ได้');
        att.deadline = Math.max(att.deadline, now) + m * 60_000; att.log.push({ t, type: 'admin_extend', detail: m + ' นาที' });
      }
      await store.setJSON(K.att(sid), att);
      return json({ ok: true });
    }
    default: return err(404, 'nf', 'ไม่พบคำสั่ง');
  }
}

// ---------- router ----------
export async function handle(req, ctx) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  try {
    if (req.method === 'GET' && path === 'status') return await status(req, ctx);
    if (req.method === 'POST') {
      if (path === 'start') return await start(req, ctx);
      if (path === 'save') return await save(req, ctx);
      if (path === 'event') return await event(req, ctx);
      if (path === 'submit') return await submit(req, ctx);
      if (path === 'admin/login') return await adminLogin(req, ctx);
    }
    if (path.startsWith('admin/')) return await admin(req, ctx, path.slice(6));
    return err(404, 'nf', 'ไม่พบเส้นทาง');
  } catch (e) {
    console.error(e);
    return err(500, 'server', 'เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่');
  }
}

// เซิร์ฟเวอร์ทดสอบในเครื่อง (ไม่ต้องใช้ Netlify): npm run dev แล้วเปิด http://localhost:8888
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { handle } from '../netlify/functions/lib/core.mjs'; import { memStore } from './memstore.mjs';
const store = memStore(); const env = { ADMIN_PASSWORD: process.env.ADMIN_PASSWORD, TOKEN_SECRET: 'dev' };
const root = path.resolve('public'); const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handle(new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), { store, now: Date.now(), env, ip: '127.0.0.1' });
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(Buffer.from(await r.arrayBuffer()));
  }
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html'; if (p === '/admin') p = '/admin.html';
  const f = path.join(root, p); if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(process.env.PORT || 8888, () => console.log('http://localhost:' + (process.env.PORT || 8888), 'admin password:', env.ADMIN_PASSWORD || 'Yongyut032437'));

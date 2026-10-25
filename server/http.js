// Minimal HTTP toolkit: router, JSON/multipart parsing, cookies, rate limiting, static files, security headers.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

class HttpError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code; } }
const bad = (m, code) => new HttpError(400, m, code);
const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);

const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts });
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const isSecure = req => req.socket.encrypted || (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' || cfg.BASE_URL.startsWith('https://');
function setCookie(res, req, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (isSecure(req)) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [].concat(prev, parts.join('; ')));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, `Upload too large (limit ${Math.round(limit / 1048576)} MB).`)); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw bad('Invalid upload');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {}; let file = null;
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    let part = buf.subarray(pos + boundary.length + 2, next - 2); // strip CRLF around
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const head = part.subarray(0, headEnd).toString('utf8');
      const data = part.subarray(headEnd + 4);
      const name = /name="([^"]*)"/i.exec(head)?.[1];
      const filename = /filename="([^"]*)"/i.exec(head)?.[1];
      const ctype = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1];
      if (filename !== undefined && name === 'file') file = { filename: path.basename(filename), mime: (ctype || 'application/octet-stream').trim(), data };
      else if (name) fields[name] = data.toString('utf8');
    }
    pos = next;
  }
  return { fields, file };
}

// naive in-memory rate limiter (per IP + bucket)
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now(); const rec = hits.get(key) || { n: 0, reset: t + windowMs };
  if (t > rec.reset) { rec.n = 0; rec.reset = t + windowMs; }
  rec.n++; hits.set(key, rec);
  if (rec.n > max) throw new HttpError(429, 'Too many attempts. Please wait a minute and try again.');
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (t > v.reset) hits.delete(k); }, 60000).unref();
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(cfg.PUBLIC_DIR, p));
  if (!file.startsWith(cfg.PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (path.extname(p)) { res.writeHead(404); return res.end('Not found'); }
    return serveStatic({ ...req, url: '/' }, res);
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300' });
  fs.createReadStream(file).pipe(res);
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// handler(ctx) -> returns JSON data, or handles res itself and returns undefined with ctx.handled = true
async function handle(req, res, authenticate) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://x');
  // Android app link: tells Android that the installed .apk is the official app of this website (so it opens full screen, without a browser bar).
  // Set ANDROID_PACKAGE and ANDROID_SHA256 (comma separated) in the host settings after building the .apk.
  if (url.pathname === '/.well-known/assetlinks.json') {
    const pkg = (process.env.ANDROID_PACKAGE || '').trim(), fps = (process.env.ANDROID_SHA256 || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    if (!pkg || !fps.length) { res.writeHead(404); return res.end('Not found'); }
    return sendJson(res, 200, [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps } }]);
  }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  try {
    // CSRF defence in depth: cookies are SameSite=Lax; additionally reject cross-origin state-changing requests.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) { let ok = false; try { ok = new URL(origin).host === req.headers.host; } catch (_) {} if (!ok) throw forbidden('Cross-origin request blocked.'); }
    }
    const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    if (!r) throw notFound('Unknown endpoint');
    const m = r.re.exec(url.pathname);
    const params = {}; r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
    const ctx = { req, res, url, params, query: Object.fromEntries(url.searchParams), ip: clientIp(req), body: {}, file: null, user: null };
    if (r.opts.limit) rateLimit(`${r.opts.limit.bucket}:${ctx.ip}`, r.opts.limit.max, 60000);
    if (r.opts.auth !== false) { ctx.user = authenticate(req); if (!ctx.user) throw new HttpError(401, 'Please log in.', 'auth'); }
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      const ct = req.headers['content-type'] || '';
      if (ct.startsWith('multipart/form-data')) {
        const buf = await readBody(req, cfg.MAX_UPLOAD_MB * 1048576 + 65536);
        const mp = parseMultipart(buf, ct); ctx.body = mp.fields; ctx.file = mp.file;
      } else {
        const buf = await readBody(req, 1048576);
        if (buf.length) { try { ctx.body = JSON.parse(buf.toString('utf8')); } catch (_) { throw bad('Invalid JSON'); } }
      }
    }
    const out = await r.handler(ctx);
    if (ctx.handled) return;
    sendJson(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    if (res.headersSent) { res.end(); return; }
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, code: e.code });
    console.error('[error]', req.method, req.url, e);
    sendJson(res, 500, { error: 'Something went wrong on the server. Please try again.' });
  }
}

module.exports = { route, handle, HttpError, bad, forbidden, notFound, parseCookies, setCookie, rateLimit, sendJson, clientIp };

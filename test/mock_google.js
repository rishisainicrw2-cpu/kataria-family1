// A local stand-in for the parts of Google OAuth + Drive v3 that KATARIA FAMILY uses.
// It is NOT Google: it lets the test-suite exercise the real upload/download/permission code paths offline.
// Passing these tests does not prove anything about a live Google account — that must be checked once by the owner (see README).
const http = require('http');
const crypto = require('crypto');

const ROOT_ID = '19c1XVBgxeafcZpllGh2GA3ap2wk6BHUO';
const FOLDER = 'application/vnd.google-apps.folder';

function startMock(port) {
  const st = {
    files: new Map(),                 // id -> {id,name,mimeType,parents,data,trashed}
    refreshTokens: new Map(),         // token -> {revoked}
    access: new Set(),
    mode: 'ok',                       // ok | down | quota
    rateLimitNext: 0,                 // answer the next N Drive calls with 429
    rootWritable: true,
    log: [],                          // [method path] of Drive calls
    apiCalls: 0,
  };
  const reset = () => {
    st.files.clear(); st.refreshTokens.clear(); st.access.clear();
    st.mode = 'ok'; st.rateLimitNext = 0; st.rootWritable = true; st.log = []; st.apiCalls = 0;
    st.files.set(ROOT_ID, { id: ROOT_ID, name: 'KATARIA FAMILY (Drive)', mimeType: FOLDER, parents: [], trashed: false });
  };
  reset();

  const send = (res, status, obj, headers = {}) => {
    const body = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': Buffer.isBuffer(obj) ? 'application/octet-stream' : 'application/json', 'Content-Length': body.length, ...headers });
    res.end(body);
  };
  const readBody = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const newId = () => crypto.randomBytes(14).toString('base64url');

  function parseRelated(buf, boundary) {
    const parts = [];
    const delim = Buffer.from('--' + boundary);
    let pos = buf.indexOf(delim);
    while (pos !== -1) {
      const next = buf.indexOf(delim, pos + delim.length);
      if (next === -1) break;
      const part = buf.subarray(pos + delim.length + 2, next - 2); // strip CRLF after delimiter and before next
      const sep = part.indexOf('\r\n\r\n');
      parts.push({ headers: part.subarray(0, sep).toString(), body: part.subarray(sep + 4) });
      pos = next;
    }
    return parts;
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://mock');
    const p = u.pathname;
    try {
      // ---- control channel for tests ----
      if (p === '/__ctl') { const b = JSON.parse((await readBody(req)).toString() || '{}'); if (b.reset) reset(); for (const k of ['mode', 'rateLimitNext', 'rootWritable']) if (k in b) st[k] = b[k]; if (b.revoke) for (const v of st.refreshTokens.values()) v.revoked = true; if (b.plant) { const id = newId(); st.files.set(id, { id, name: b.plant.name, mimeType: 'application/octet-stream', parents: [b.plant.parent], data: Buffer.from(b.plant.data, 'base64'), trashed: false }); } return send(res, 200, { ok: true }); }
      if (p === '/__state') return send(res, 200, {
        files: [...st.files.values()].map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, size: f.data ? f.data.length : 0, trashed: f.trashed, data: f.data ? f.data.toString('base64') : undefined })),
        log: st.log, apiCalls: st.apiCalls, refreshTokens: [...st.refreshTokens.keys()], revoked: [...st.refreshTokens].filter(([, v]) => v.revoked).map(([k]) => k), accessTokens: [...st.access],
      });

      // ---- OAuth ----
      if (p === '/auth') return send(res, 200, { note: 'consent screen would be here' });
      if (p === '/token') {
        const f = new URLSearchParams((await readBody(req)).toString());
        if (f.get('client_id') !== 'test-client-id' || f.get('client_secret') !== 'test-client-secret') return send(res, 401, { error: 'invalid_client' });
        if (f.get('grant_type') === 'authorization_code') {
          if (f.get('code') !== 'good-code') return send(res, 400, { error: 'invalid_grant', error_description: 'bad code' });
          const rt = 'RT-' + newId(); st.refreshTokens.set(rt, { revoked: false });
          const at = 'AT-' + newId(); st.access.add(at);
          return send(res, 200, { access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'Bearer' });
        }
        if (f.get('grant_type') === 'refresh_token') {
          const rt = st.refreshTokens.get(f.get('refresh_token'));
          if (!rt || rt.revoked) return send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
          const at = 'AT-' + newId(); st.access.add(at);
          return send(res, 200, { access_token: at, expires_in: 3600, token_type: 'Bearer' });
        }
        return send(res, 400, { error: 'unsupported_grant_type' });
      }
      if (p === '/revoke') { const f = new URLSearchParams((await readBody(req)).toString()); const rt = st.refreshTokens.get(f.get('token')); if (rt) rt.revoked = true; return send(res, 200, {}); }

      // ---- Drive (needs a bearer token) ----
      if (p.startsWith('/drive/v3') || p.startsWith('/upload/drive/v3')) {
        st.apiCalls++; st.log.push(req.method + ' ' + p);
        const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (!st.access.has(bearer)) return send(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });
        if (st.mode === 'down') return send(res, 503, { error: { code: 503, message: 'Service Unavailable' } });
        if (st.rateLimitNext > 0) { st.rateLimitNext--; return send(res, 429, { error: { code: 429, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }); }
        const rest = p.replace('/upload/drive/v3', '').replace('/drive/v3', '');

        if (rest === '/about') return send(res, 200, { user: { emailAddress: 'family.owner@example.com' }, storageQuota: { limit: '16106127360', usage: '1048576' } });

        if (rest === '/files' && req.method === 'GET') {
          const qs = u.searchParams.get('q') || '';
          // Supports the two query shapes the app uses: folder lookup by name, and "files in a folder".
          const parent = (qs.match(/^'([^']+)' in parents/) || [])[1];
          const nameEq = (qs.match(/name='((?:[^'\\]|\\.)*)'/) || [])[1];
          const mimeEq = (qs.match(/mimeType='([^']+)'/) || [])[1];
          const mimeNe = (qs.match(/mimeType!='([^']+)'/) || [])[1];
          const out = !parent ? [] : [...st.files.values()].filter(f => f.parents.includes(parent) && !f.trashed
            && (nameEq === undefined || f.name === nameEq.replace(/\\(.)/g, '$1')) && (!mimeEq || f.mimeType === mimeEq) && (!mimeNe || f.mimeType !== mimeNe)).map(f => ({ id: f.id, name: f.name }));
          return send(res, 200, { files: out });
        }
        if (rest === '/files' && req.method === 'POST') {
          const raw = await readBody(req);
          if (u.pathname.startsWith('/upload')) {
            if (st.mode === 'quota') return send(res, 403, { error: { code: 403, message: 'The user storage quota has been exceeded.', errors: [{ reason: 'storageQuotaExceeded' }] } });
            const bm = (req.headers['content-type'] || '').match(/boundary=(.+)$/);
            const parts = parseRelated(raw, bm[1]);
            const meta = JSON.parse(parts[0].body.toString());
            const parent = st.files.get(meta.parents?.[0]);
            if (!parent || parent.mimeType !== FOLDER) return send(res, 404, { error: { code: 404, message: 'File not found: parent' } });
            const mime = (parts[1].headers.match(/Content-Type:\s*(\S+)/i) || [])[1] || 'application/octet-stream';
            const id = newId(); st.files.set(id, { id, name: meta.name, mimeType: mime, parents: meta.parents, data: Buffer.from(parts[1].body), trashed: false });
            return send(res, 200, { id, name: meta.name, size: String(parts[1].body.length), mimeType: mime });
          }
          const meta = JSON.parse(raw.toString());
          if (!st.rootWritable && (meta.parents || []).includes(ROOT_ID)) return send(res, 403, { error: { code: 403, message: 'insufficient permissions', errors: [{ reason: 'forbidden' }] } });
          const id = newId(); st.files.set(id, { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents || [], trashed: false });
          return send(res, 200, { id });
        }
        const fm = rest.match(/^\/files\/([^/]+)$/);
        if (fm) {
          const f = st.files.get(fm[1]);
          if (!f) return send(res, 404, { error: { code: 404, message: 'File not found: ' + fm[1], errors: [{ reason: 'notFound' }] } });
          if (req.method === 'DELETE') { st.files.delete(f.id); res.writeHead(204); return res.end(); }
          if (u.searchParams.get('alt') === 'media') {
            const range = (req.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
            if (range) {
              const a = +range[1], b = range[2] ? Math.min(+range[2], f.data.length - 1) : f.data.length - 1;
              return send(res, 206, f.data.subarray(a, b + 1), { 'Content-Range': `bytes ${a}-${b}/${f.data.length}` });
            }
            return send(res, 200, f.data);
          }
          if (u.searchParams.get('fields')?.includes('thumbnailLink')) return send(res, 200, {});
          return send(res, 200, { id: f.id, name: f.name, mimeType: f.mimeType, trashed: f.trashed, capabilities: { canAddChildren: f.id === ROOT_ID ? st.rootWritable : true } });
        }
        return send(res, 404, { error: { code: 404, message: 'unhandled mock route ' + req.method + ' ' + rest } });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 500, { error: String(e && e.stack || e) }); }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, close: () => new Promise(r => server.close(r)), url: `http://127.0.0.1:${port}` })));
}

module.exports = { startMock, ROOT_ID };

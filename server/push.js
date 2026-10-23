// Web Push without a third-party SDK: VAPID-signed, payload-less "tickle" pushes.
// The service worker then fetches the latest notification itself (same-origin, with the session cookie).
// UNTESTED against a real push service in the build environment (outbound network was restricted) — see README.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { q } = require('./db');

const file = path.join(cfg.DATA_DIR, 'vapid.json');
let keys;
if (fs.existsSync(file)) keys = JSON.parse(fs.readFileSync(file, 'utf8'));
else {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  keys = { d: jwk.d, x: jwk.x, y: jwk.y };
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
}
const privateKey = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', ...keys }, format: 'jwk' });
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(keys.x, 'base64url'), Buffer.from(keys.y, 'base64url')]).toString('base64url');

function jwt(aud) {
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = b({ typ: 'JWT', alg: 'ES256' }) + '.' + b({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:admin@kataria.family' });
  return data + '.' + crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}
async function tickle(userId) {
  const subs = q.all('SELECT endpoint FROM push_subs WHERE user_id=?', userId);
  for (const s of subs) {
    try {
      const r = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: `vapid t=${jwt(new URL(s.endpoint).origin)}, k=${publicKey}`, TTL: '3600', Urgency: 'normal', 'Content-Length': '0' } });
      if (r.status === 404 || r.status === 410) q.run('DELETE FROM push_subs WHERE endpoint=?', s.endpoint);
    } catch (_) { /* push service unreachable — in-app notifications still work */ }
  }
}
module.exports = { publicKey, tickle };

// Web Push without a third-party SDK: VAPID-signed, payload-less "tickle" pushes.
// The service worker then fetches the latest notification itself (same-origin, with the session cookie).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { q } = require('./db');

// The push keys are derived from SECRET_KEY, so they stay the same after every restart of the (free, forgetful) server.
// If they changed, every phone that already allowed notifications would stop receiving them.
function derivePrivate() {
  const secret = Buffer.from(String(cfg.SECRET_KEY));
  for (let n = 0; n < 50; n++) {
    const d = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from('hindu-esports'), Buffer.from('vapid-p256-' + n), 32));
    try { const e = crypto.createECDH('prime256v1'); e.setPrivateKey(d); const pub = e.getPublicKey(); return { d, pub }; } catch (_) { /* not a valid scalar, try next */ }
  }
  throw new Error('could not derive push keys');
}
const { d: dRaw, pub: pubRaw } = derivePrivate();
const keys = { d: dRaw.toString('base64url'), x: pubRaw.subarray(1, 33).toString('base64url'), y: pubRaw.subarray(33, 65).toString('base64url') };
const privateKey = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', ...keys }, format: 'jwk' });
const publicKey = pubRaw.toString('base64url');

function jwt(aud) {
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = b({ typ: 'JWT', alg: 'ES256' }) + '.' + b({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: cfg.BASE_URL && cfg.BASE_URL.startsWith('https://') ? cfg.BASE_URL : 'mailto:admin@example.com' });
  return data + '.' + crypto.sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}
// What the phone should show for the next push. The push itself carries no text (keeps messages off third-party push servers):
// the service worker asks the server for this a moment later, with the user's own session.
const pending = new Map();
const takePending = userId => { const p = pending.get(userId); pending.delete(userId); return p; };
async function tickle(userId, payload) {
  if (payload) pending.set(userId, { title: String(payload.title || 'HINDU ESPORTS').slice(0, 80), body: String(payload.body || '').slice(0, 140), url: payload.url || '#/home', at: Date.now() });
  const subs = q.all('SELECT endpoint FROM push_subs WHERE user_id=?', userId);
  for (const s of subs) {
    try {
      const r = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: `vapid t=${jwt(new URL(s.endpoint).origin)}, k=${publicKey}`, TTL: '3600', Urgency: 'high', 'Content-Length': '0' } });
      if (r.status === 404 || r.status === 410) q.run('DELETE FROM push_subs WHERE endpoint=?', s.endpoint);
    } catch (_) { /* push service unreachable — in-app notifications still work */ }
  }
}
module.exports = { publicKey, tickle, takePending };

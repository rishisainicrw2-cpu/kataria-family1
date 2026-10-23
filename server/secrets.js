// AES-256-GCM helpers keyed from SECRET_KEY. No database access, so it is safe to use before the database is opened (restore.js).
const crypto = require('crypto');
const cfg = require('./config');

const key = crypto.createHash('sha256').update(cfg.SECRET_KEY).digest();
const enc = s => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const e = Buffer.concat([c.update(s, 'utf8'), c.final()]); return [iv, c.getAuthTag(), e].map(b => b.toString('base64')).join('.'); };
const dec = s => { const [iv, tag, e] = s.split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(e), d.final()]).toString('utf8'); };

// Binary variant for database backups (separate key derivation so the two uses can never be confused).
const bkey = crypto.createHash('sha256').update('kf-backup:' + cfg.SECRET_KEY).digest();
const MAGIC = Buffer.from('KFB1');
function sealBytes(buf) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', bkey, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}
function openBytes(buf) {
  if (buf.length < 33 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('not a KATARIA backup file');
  const d = crypto.createDecipheriv('aes-256-gcm', bkey, buf.subarray(4, 16)); d.setAuthTag(buf.subarray(16, 32));
  try { return Buffer.concat([d.update(buf.subarray(32)), d.final()]); }
  catch { throw new Error('backup cannot be decrypted — SECRET_KEY is different from the one that created it'); }
}
module.exports = { enc, dec, sealBytes, openBytes };

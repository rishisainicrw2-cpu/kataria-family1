// Tiny RFC 6455 WebSocket server (text frames only) — no npm packages required.
const crypto = require('crypto');
const { q } = require('./db');

const clients = new Map(); // userId -> Set<socket>
let onTyping = () => {};

function accept(req, socket, user) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acc}`, '', ''].join('\r\n'));
  socket.setNoDelay(true);
  socket.userId = user.id; socket.familyId = user.familyId; socket.alive = true;
  const firstConn = !clients.has(user.id);
  if (!clients.has(user.id)) clients.set(user.id, new Set());
  clients.get(user.id).add(socket);
  if (firstConn) broadcastFamily(user.familyId, { type: 'presence', userId: user.id, online: true }, user.id);

  let buf = Buffer.alloc(0), frag = [];
  socket.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (true) {
      if (buf.length < 2) return;
      const fin = !!(buf[0] & 0x80), op = buf[0] & 0x0f, masked = !!(buf[1] & 0x80);
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1048576) return socket.destroy();
      if (!masked) return socket.destroy(); // clients must mask
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 0x8) { socket.end(); return; }
      if (op === 0x9) { writeFrame(socket, 0xA, payload); continue; }
      if (op === 0xA) { socket.alive = true; continue; }
      if (op === 0x1 || op === 0x0) {
        frag.push(payload);
        if (fin) { const text = Buffer.concat(frag).toString('utf8'); frag = []; try { handleMessage(socket, JSON.parse(text)); } catch (_) {} }
      }
    }
  });
  const cleanup = () => {
    const set = clients.get(user.id); if (!set) return; set.delete(socket);
    if (!set.size) { clients.delete(user.id); broadcastFamily(user.familyId, { type: 'presence', userId: user.id, online: false }, user.id); }
  };
  socket.on('close', cleanup); socket.on('error', () => { cleanup(); socket.destroy(); });
}

function handleMessage(socket, m) {
  if (m.type === 'typing' && typeof m.roomId === 'string') onTyping(socket.userId, m.roomId);
}

function writeFrame(socket, op, payload) {
  const len = payload.length; let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
}
const sendTo = (userId, obj) => {
  const set = clients.get(userId); if (!set) return;
  const p = Buffer.from(JSON.stringify(obj)); set.forEach(s => writeFrame(s, 0x1, p));
};
const sendToMany = (ids, obj) => ids.forEach(id => sendTo(id, obj));
function familyMemberIds(familyId) { return q.all('SELECT user_id FROM memberships WHERE family_id=?', familyId).map(r => r.user_id); }
function broadcastFamily(familyId, obj, exceptUserId) { familyMemberIds(familyId).forEach(id => { if (id !== exceptUserId) sendTo(id, obj); }); }
const isOnline = id => clients.has(id);
const onlineIds = () => [...clients.keys()];
function disconnectUser(userId) { const set = clients.get(userId); if (set) set.forEach(s => s.destroy()); clients.delete(userId); }

// keepalive: ping every 30s, drop dead sockets
setInterval(() => { clients.forEach(set => set.forEach(s => { if (!s.alive) return s.destroy(); s.alive = false; writeFrame(s, 0x9, Buffer.alloc(0)); })); }, 30000).unref();

module.exports = { accept, sendTo, sendToMany, broadcastFamily, isOnline, onlineIds, disconnectUser, setTypingHandler: f => { onTyping = f; } };

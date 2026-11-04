// Minimal SMTP client (direct TLS + AUTH LOGIN), zero npm dependencies — same philosophy as the rest of this
// project (see server/ws.js for the hand-rolled WebSocket server). Sends mail through the clan leader's own
// Gmail account using an App Password (GMAIL_USER / GMAIL_APP_PASSWORD env vars) — never the real account
// password, and never stored anywhere but the host's environment.
const tls = require('tls');

const HOST = 'smtp.gmail.com', PORT = 465, TIMEOUT_MS = 15000;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
// RFC 5321 dot-stuffing: a line that is just "." (or starts with one) would end the DATA section early.
const dotStuff = s => s.split(/\r\n|\n/).map(l => l.startsWith('.') ? '.' + l : l).join('\r\n');

function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = d => {
      buf += d.toString('utf8');
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3}-/.test(last)) return; // multi-line reply still continuing
      cleanup(); resolve(buf.trim());
    };
    const onError = reject;
    const cleanup = () => { socket.removeListener('data', onData); socket.removeListener('error', onError); };
    socket.on('data', onData); socket.on('error', onError);
  });
}
async function expect(socket, code) {
  const reply = await readReply(socket);
  if (+reply.slice(0, 3) !== code) throw new Error(`Mail server said: ${reply}`);
  return reply;
}
const write = (socket, line) => socket.write(line + '\r\n');

async function sendMail({ to, subject, text, html }) {
  const user = (process.env.GMAIL_USER || '').trim(), pass = (process.env.GMAIL_APP_PASSWORD || '').trim();
  if (!user || !pass) throw new Error('Email is not configured on this server.');

  const socket = tls.connect({ host: HOST, port: PORT, servername: HOST });
  const timer = setTimeout(() => socket.destroy(new Error('Mail server timed out')), TIMEOUT_MS);
  try {
    await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
    await expect(socket, 220);
    write(socket, 'EHLO hindu-esports.onrender.com'); await expect(socket, 250);
    write(socket, 'AUTH LOGIN'); await expect(socket, 334);
    write(socket, b64(user)); await expect(socket, 334);
    write(socket, b64(pass)); await expect(socket, 235);
    write(socket, `MAIL FROM:<${user}>`); await expect(socket, 250);
    write(socket, `RCPT TO:<${to}>`); await expect(socket, 250);
    write(socket, 'DATA'); await expect(socket, 354);
    const boundary = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const body = [
      `From: HINDU ESPORTS <${user}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      html || text.replace(/\n/g, '<br>'),
      '',
      `--${boundary}--`,
    ].join('\r\n');
    write(socket, dotStuff(body) + '\r\n.');
    await expect(socket, 250);
    write(socket, 'QUIT');
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

module.exports = { sendMail };

// HINDU ESPORTS server entry. Zero npm dependencies: needs Node.js 22+ (built-in node:sqlite, fetch, crypto).
const http = require('http');
const cfg = require('./config');

(async () => {
  // 1) On hosts that wipe the disk, bring the database back from the encrypted Drive backup BEFORE opening it.
  try { console.log('[restore]', await require('./restore').restoreIfNeeded()); }
  catch (e) { console.error('\n[restore] FATAL — refusing to start with an empty database:\n  ' + e.message + '\n  Fix the Drive connection / keys, or remove DRIVE_RESTORE_KEY to deliberately start fresh (old backups stay in Drive).\n'); process.exit(1); }

  require('./db');
  const { handle } = require('./http');
  const L = require('./lib');
  const ws = require('./ws');
  require('./routes_core');
  const { runReminders } = require('./routes_features');
  const backup = require('./backup');

  const server = http.createServer((req, res) => handle(req, res, L.authenticate));

  server.on('upgrade', (req, socket) => {
    try {
      if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return socket.destroy(); // block cross-site WebSocket hijacking
      const user = L.authenticate(req);
      if (!user || !user.familyId) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
      ws.accept(req, socket, user);
    } catch (e) { socket.destroy(); }
  });

  server.listen(cfg.PORT, () => {
    console.log(`HINDU ESPORTS running on port ${cfg.PORT}`);
    console.log(`Data directory: ${cfg.DATA_DIR}`);
    console.log(`Google Drive OAuth: ${cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && cfg.BASE_URL ? 'configured' : 'NOT configured (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BASE_URL)'}`);
    if (!process.env.SECRET_KEY) console.log('WARNING: SECRET_KEY is not set — it is stored in the data directory. On a host with an ephemeral disk set SECRET_KEY, or Drive tokens and backups cannot be decrypted after a restart.');
  });
  setInterval(() => { try { runReminders(); } catch (e) { console.error('[reminders]', e); } }, 60000).unref();
  backup.start();

  let stopping = false;
  const shutdown = async sig => {
    if (stopping) return; stopping = true;
    console.log(`[${sig}] saving a final backup before stopping…`);
    server.close();
    try { await backup.finalBackup(); } catch (e) { console.error('[backup:final]', e.message); }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', e => console.error('[uncaught]', e));
  process.on('unhandledRejection', e => console.error('[unhandled]', e));
})();

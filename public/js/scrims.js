/* Scrims & Tournaments — fully standalone client. No dependency on /js/core.js or the clan app:
   nothing here can read clan data, and nothing in the clan app can be reached from this page. */
(function () {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDate = t => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

async function api(path, opts = {}) {
  const o = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  let res;
  try { res = await fetch('/api/scrims' + path, o); }
  catch (e) { const err = new Error('You appear to be offline. Please check your connection.'); err.offline = true; throw err; }
  let data = null; try { data = await res.json(); } catch (_) {}
  if (!res.ok) { const err = new Error((data && data.error) || `Request failed (${res.status})`); err.status = res.status; throw err; }
  return data;
}

let toastT;
function toast(msg, ms = 2800) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), ms);
}
function sheet(html, onMount) {
  const bg = document.createElement('div'); bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  $('#overlay').appendChild(bg);
  onMount && onMount($('.sheet', bg), close);
  return close;
}
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch (_) { toast(t); } }

const state = { me: null, msgs: [], online: [], pinned: [], ws: null, wsRetry: 0 };

/* ---------- join screen ---------- */
function showJoin(prefillCode, errorMsg) {
  const box = $('#splashBody');
  box.innerHTML = `
    <div class="joinbox">
      <div class="small muted">Enter your invitation code and a display name to join the chat.</div>
      <label for="jcode">Invitation code</label>
      <input id="jcode" placeholder="XXXX-XXXX" autocomplete="off" value="${esc(prefillCode || '')}">
      <label for="jname">Display name</label>
      <input id="jname" placeholder="Your player name" autocomplete="off" maxlength="40">
      <div class="err" data-err>${esc(errorMsg || '')}</div>
      <button class="btn block" data-join>Join Scrims &amp; Tournaments</button>
    </div>`;
  $('[data-join]', box).onclick = async () => {
    const code = $('#jcode', box).value.trim(), name = $('#jname', box).value.trim();
    const err = $('[data-err]', box);
    if (!code) { err.textContent = 'Enter your invitation code.'; return; }
    if (!name) { err.textContent = 'Enter a display name.'; return; }
    const btn = $('[data-join]', box); btn.disabled = true; err.textContent = '';
    try { await api('/join', { method: 'POST', body: { code, name } }); location.href = '/scrims'; }
    catch (e) { err.textContent = e.message; btn.disabled = false; }
  };
}

/* ---------- chat ---------- */
function roleBadge(m) { return m.role === 'admin' ? '<span class="pill admin">Admin</span>' : ''; }
function bubble(m) {
  if (m.deleted) return `<div class="msg deleted" data-id="${m.id}">Message removed</div>`;
  if (m.kind === 'announcement') return `<div class="msg announcement" data-id="${m.id}"><div class="who">📣 ${esc(m.authorName)} ${roleBadge(m)}</div><div class="text">${esc(m.text)}</div><div class="meta">${fmtTime(m.createdAt)}</div></div>`;
  if (m.kind === 'room') return roomBubble(m);
  return `<div class="msg ${m.mine ? 'me' : ''}" data-id="${m.id}">
    <div class="who">${esc(m.authorName)} ${roleBadge(m)}</div>
    <div class="text">${esc(m.text)}</div>
    <div class="meta">${fmtTime(m.createdAt)}</div></div>`;
}
function roomBubble(m) {
  let fields = {}; try { fields = JSON.parse(m.text); } catch (_) { fields = { note: m.text }; }
  const row = (k, v) => v ? `<div class="roomfield"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span><button class="icon-btn small" data-copy="${esc(v)}">📋</button></div>` : '';
  return `<div class="msg room" data-id="${m.id}"><div class="who">🔑 Match room — ${esc(m.authorName)} ${roleBadge(m)}</div>
    ${row('Room ID', fields.roomId)}${row('Password', fields.password)}${fields.note ? `<div class="text" style="margin-top:6px">${esc(fields.note)}</div>` : ''}
    <div class="meta">${fmtTime(m.createdAt)}</div></div>`;
}
function render() {
  const body = $('#body');
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  if (!state.msgs.length) { body.innerHTML = '<div class="empty"><div class="big">🏆</div>No messages yet. Say hello!</div>'; return; }
  let html = '', lastDay = '';
  for (const m of state.msgs) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) { html += `<div class="day">${day === new Date().toDateString() ? 'Today' : fmtDate(m.createdAt)}</div>`; lastDay = day; }
    html += bubble(m);
  }
  body.innerHTML = html;
  body.scrollTop = body.scrollHeight;
  if (!atBottom) {} // (kept simple: always snap to bottom, this is a low-traffic group chat)
  wireMessageActions();
}
function renderPinned() {
  const el = $('#pinned'), inner = $('[data-pinned]', el);
  const anns = state.pinned.filter(m => !m.deleted);
  if (!anns.length) { el.classList.remove('on'); inner.innerHTML = ''; return; }
  el.classList.add('on');
  inner.innerHTML = anns.map(m => `<div>📌 <b>${esc(m.authorName)}:</b> ${esc(m.text)}</div>`).join('');
}
function wireMessageActions() {
  $$('[data-copy]', $('#body')).forEach(b => b.onclick = () => copyText(b.dataset.copy));
  $$('.msg', $('#body')).forEach(el => {
    el.oncontextmenu = e => { e.preventDefault(); openMsgMenu(el.dataset.id); };
    let t; el.addEventListener('touchstart', () => { t = setTimeout(() => openMsgMenu(el.dataset.id), 500); });
    el.addEventListener('touchend', () => clearTimeout(t));
    el.addEventListener('dblclick', () => openMsgMenu(el.dataset.id));
  });
}
function openMsgMenu(id) {
  const m = state.msgs.find(x => String(x.id) === String(id)); if (!m || m.deleted) return;
  const admin = state.me.kind === 'admin';
  sheet(`<div class="gap">
    <button class="btn ghost" data-a="report">🚩 Report</button>
    ${admin ? `<button class="btn ghost" data-a="pin">${m.pinned ? 'Unpin' : '📌 Pin'}</button>` : ''}
    ${admin ? '<button class="btn danger" data-a="del">Delete</button>' : ''}
  </div>`, (s, close) => {
    $$('[data-a]', s).forEach(b => b.onclick = async () => {
      close(); const a = b.dataset.a;
      try {
        if (a === 'report') { const reason = prompt('What is wrong with this message? (optional)') || ''; await api(`/messages/${id}/report`, { method: 'POST', body: { reason } }); toast('Reported to the clan leaders'); }
        else if (a === 'pin') { await api(`/messages/${id}/pin`, { method: 'POST' }); }
        else if (a === 'del') { await api(`/messages/${id}`, { method: 'DELETE' }); }
      } catch (e) { toast(e.message); }
    });
  });
}

async function loadMessages() { state.msgs = await api('/messages'); render(); }
async function loadPinned() { state.pinned = await api('/pinned'); renderPinned(); }
async function loadRoom() { const r = await api('/room'); state.online = r.online; updateSub(); }
function updateSub() {
  const n = state.online.length;
  $('[data-sub]').textContent = state.me.kind === 'admin' ? `Managing as ${state.me.name} · ${n} online` : `${n} online`;
}

function connectWS() {
  if (state.ws && state.ws.readyState <= 1) return;
  const ws = state.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { state.wsRetry = 0; };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.type === 'scrims.message') { if (!state.msgs.some(x => x.id === m.message.id)) { m.message.mine = m.message.role === state.me.role && m.message.authorName === state.me.name; state.msgs.push(m.message); render(); } if (m.message.kind === 'announcement') loadPinned(); }
    else if (m.type === 'scrims.message_update') { const i = state.msgs.findIndex(x => x.id === m.message.id); if (i >= 0) { state.msgs[i] = m.message; render(); } loadPinned(); }
    else if (m.type === 'presence' || m.type === 'scrims.participant_removed') loadRoom().catch(() => {});
  };
  ws.onclose = () => { state.wsRetry = Math.min(state.wsRetry + 1, 6); setTimeout(connectWS, 800 * state.wsRetry); };
}

async function send() {
  const input = $('[data-in]'); const text = input.value.trim(); if (!text) return;
  const btn = $('[data-send]'); btn.disabled = true;
  try {
    const m = await api('/messages', { method: 'POST', body: { text } });
    if (!state.msgs.some(x => x.id === m.id)) { state.msgs.push(m); render(); }
    input.value = ''; input.style.height = 'auto';
  } catch (e) { toast(e.offline ? 'Offline — try again when connected.' : e.message); }
  finally { btn.disabled = false; input.focus(); }
}

/* ---------- admin-only tools (only ever shown when the server confirms me.kind === 'admin') ---------- */
function openAnnounce() {
  sheet(`<h2>📣 Post announcement</h2><label>Message</label><textarea data-t rows="3" placeholder="Tournament starts at 8 PM IST…"></textarea>
    <button class="btn block" data-go>Post &amp; pin</button>`, (s, close) => {
    $('[data-go]', s).onclick = async () => { const text = $('[data-t]', s).value.trim(); if (!text) return; try { await api('/messages', { method: 'POST', body: { text, kind: 'announcement' } }); close(); } catch (e) { toast(e.message); } };
  });
}
function openRoomInfo() {
  sheet(`<h2>🔑 Share match room info</h2><label>Room ID</label><input data-rid><label>Password</label><input data-rpw><label>Note (optional)</label><input data-rn placeholder="e.g. Match 2, Squad mode">
    <div class="small muted" style="margin-top:10px">Only people already in this chat can see this — the link is never public.</div>
    <button class="btn block" data-go>Post to chat</button>`, (s, close) => {
    $('[data-go]', s).onclick = async () => {
      const roomId = $('[data-rid]', s).value.trim(), password = $('[data-rpw]', s).value.trim(), note = $('[data-rn]', s).value.trim();
      if (!roomId && !password) return;
      try { await api('/messages', { method: 'POST', body: { kind: 'room', text: JSON.stringify({ roomId, password, note }) } }); close(); } catch (e) { toast(e.message); }
    };
  });
}
async function openInvites() {
  let list; try { list = await api('/invites'); } catch (e) { toast(e.message); return; }
  const linkFor = c => `${location.origin}/join-scrims?code=${encodeURIComponent(c)}`;
  const render2 = () => `<h2>✉️ Invitation links</h2><button class="btn block" data-new style="margin-bottom:14px">+ New invite link</button>
    ${list.length ? list.map(i => `<div class="card"><div class="row"><b class="grow" style="letter-spacing:1px">${esc(i.code)}</b><span class="pill ${i.active ? 'admin' : ''}">${i.active ? 'Active' : i.revoked ? 'Disabled' : 'Expired'}</span></div>
      ${i.label ? `<div class="small muted">${esc(i.label)}</div>` : ''}
      <div class="small muted">Used ${i.uses}${i.maxUses ? '/' + i.maxUses : ' (no limit)'}${i.expiresAt ? ' · expires ' + fmtDate(i.expiresAt) : ' · never expires'}</div>
      <div class="row wrap" style="margin-top:8px">
        <button class="btn small" data-copy="${esc(linkFor(i.code))}">Copy link</button>
        <button class="btn small ghost" data-regen="${i.id}">Regenerate</button>
        <button class="btn small ${i.revoked ? '' : 'danger'}" data-toggle="${i.id}" data-rev="${i.revoked ? '0' : '1'}">${i.revoked ? 'Re-enable' : 'Disable'}</button>
      </div></div>`).join('') : '<div class="empty small">No invite links yet.</div>'}`;
  const close0 = sheet(render2(), wire);
  function wire(s) {
    $$('[data-copy]', s).forEach(b => b.onclick = () => copyText(b.dataset.copy));
    $('[data-new]', s).onclick = async () => {
      const label = prompt('Label for this link (optional, e.g. "Diwali Cup")') || '';
      try { await api('/invites', { method: 'POST', body: { label } }); list = await api('/invites'); refresh(s); toast('Invite link created'); } catch (e) { toast(e.message); }
    };
    $$('[data-regen]', s).forEach(b => b.onclick = async () => { try { await api(`/invites/${b.dataset.regen}/regenerate`, { method: 'POST' }); list = await api('/invites'); refresh(s); toast('New link generated — the old one stopped working'); } catch (e) { toast(e.message); } });
    $$('[data-toggle]', s).forEach(b => b.onclick = async () => { try { await api(`/invites/${b.dataset.toggle}`, { method: 'PATCH', body: { revoked: b.dataset.rev === '1' } }); list = await api('/invites'); refresh(s); } catch (e) { toast(e.message); } });
  }
  function refresh(s) { s.innerHTML = render2(); wire(s); }
}
async function openPlayers() {
  let list; try { list = await api('/participants'); } catch (e) { toast(e.message); return; }
  sheet(`<h2>👥 Players in Scrims &amp; Tournaments</h2>${list.length ? `<div class="list">${list.map(p => `<div class="row"><span class="grow">${p.online ? '<span class="dot"></span>' : ''}${esc(p.name)}</span><button class="btn small danger" data-rm="${p.id}">Remove</button></div>`).join('')}</div>` : '<div class="empty small">No one has joined yet.</div>'}`,
    (s, close) => { $$('[data-rm]', s).forEach(b => b.onclick = async () => { if (!confirm('Remove this player? Their invite link access is revoked immediately.')) return; try { await api('/participants/' + b.dataset.rm, { method: 'DELETE' }); close(); openPlayers(); } catch (e) { toast(e.message); } }); });
}

function showChat() {
  $('#splash').classList.add('hidden');
  $('#chat').classList.add('on');
  if (state.me.kind === 'admin') $('#adminbar').classList.add('on');
  updateSub();
  loadMessages(); loadPinned(); loadRoom();
  connectWS();
  const input = $('[data-in]');
  $('[data-send]').onclick = send;
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(min-width:700px)').matches) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 110) + 'px'; });
  $('[data-leave]').onclick = async () => {
    if (state.me.kind === 'admin') { toast('Leaders manage Scrims from their clan account — nothing to leave.'); return; }
    if (!confirm('Leave Scrims & Tournaments? You can rejoin any time with a new invite link.')) return;
    try { await api('/leave', { method: 'POST' }); } catch (_) {}
    location.href = '/join-scrims';
  };
  $('[data-announce]', $('#adminbar'))?.addEventListener('click', openAnnounce);
  $('[data-room]', $('#adminbar'))?.addEventListener('click', openRoomInfo);
  $('[data-invites]', $('#adminbar'))?.addEventListener('click', openInvites);
  $('[data-players]', $('#adminbar'))?.addEventListener('click', openPlayers);
}

async function boot() {
  const params = new URLSearchParams(location.search);
  try {
    state.me = await api('/me');
    showChat();
  } catch (e) {
    if (location.pathname === '/scrims' && !params.get('code')) { showJoin('', 'Open the invitation link you were given, or enter your code below.'); return; }
    showJoin(params.get('code') || '');
  }
}
boot();
})();

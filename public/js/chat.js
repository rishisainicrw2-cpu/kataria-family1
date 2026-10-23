/* Chats list + chat room (general, daily, events, planning, shopping, private DMs) */
const ROOM_ICON = { general: '🏠', daily: '☀️', events: '🎉', planning: '🧭', shopping: '🛒', dm: '💬' };
const EMOJIS = '😀 😂 🥰 😍 😘 😎 🤗 😢 😭 😡 👍 👎 🙏 👏 🎉 🎂 ❤️ 💙 ✨ 🔥 🍕 🍰 ☕ 🏖️ ✈️ 🚗 🏠 📸 🎁 💐 🌙 ☀️'.split(' ');
const STICKERS = ['👨‍👩‍👧‍👦', '🎊', '🥳', '🤝', '💪', '🙌', '🍽️', '🎶'];

async function loadRooms() {
  KF.state.rooms = await api('/rooms');
  KF.updateBadges();
  return KF.state.rooms;
}
KF.loadRooms = loadRooms;

KF.updateBadges = () => {
  const n = KF.state.rooms.reduce((a, r) => a + (r.muted ? 0 : r.unread || 0), 0);
  const el = $('#nav [data-tab=chats] .badge');
  if (el) { el.textContent = n > 99 ? '99+' : n; el.classList.toggle('hidden', !n); }
};

KF.views.chats = async view => {
  const rooms = await loadRooms();
  const dms = rooms.filter(r => r.type === 'dm'), groups = rooms.filter(r => r.type !== 'dm');
  const row = r => `<a class="row" href="#/room/${r.id}" style="text-decoration:none;color:inherit">
      ${r.type === 'dm' ? avatar(member(r.peerId)) : `<span class="avatar" style="font-size:1.3rem">${ROOM_ICON[r.type] || '💬'}</span>`}
      <div class="grow"><div class="row"><b class="grow">${esc(r.name)}</b><span class="small muted">${r.lastAt ? fmtTime(r.lastAt) : ''}</span></div>
      <div class="small muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.muted ? '🔕 ' : ''}${esc(r.lastText || 'No messages yet')}</div></div>
      ${r.unread && !r.muted ? `<span class="badge">${r.unread}</span>` : ''}</a>`;
  const others = KF.state.members.filter(m => m.id !== KF.state.me.id);
  view.innerHTML = `<div class="gap fade">
    <div class="card"><h3>Family rooms</h3><div class="list">${groups.map(row).join('')}</div></div>
    <div class="card"><div class="row"><h3 class="grow" style="margin:0">Private chats</h3></div>
      ${dms.length ? `<div class="list">${dms.map(row).join('')}</div>` : '<div class="muted small" style="margin-top:8px">Only you and the other person can see a private chat.</div>'}
      ${others.length ? `<div class="chips" style="margin-top:12px">${others.map(m => `<button class="chip" data-dm="${m.id}">＋ ${esc(m.name.split(' ')[0])}</button>`).join('')}</div>` : '<div class="empty small">Invite family members to start private chats.</div>'}</div>
    <a class="btn ghost block" href="#/search" style="text-align:center;text-decoration:none">${icon('search', 'width="18" height="18" style="vertical-align:-4px"')} Search all messages</a>
  </div>`;
  $$('[data-dm]', view).forEach(b => b.onclick = async () => {
    try { const r = await api('/dms', { method: 'POST', body: { userId: b.dataset.dm } }); location.hash = '#/room/' + r.id; } catch (e) { toast(e.message); }
  });
};

KF.views.room = async (view, params) => {
  const roomId = params[0];
  if (!KF.state.rooms.length) await loadRooms();
  let room = KF.state.rooms.find(r => r.id === roomId);
  if (!room) { try { room = await api('/rooms/' + roomId); } catch (_) { room = null; } } // e.g. a plan's discussion thread
  if (!room) { view.innerHTML = '<div class="empty"><div class="big">🔒</div>Chat not found or you do not have access.</div>'; return; }
  KF.setTitle(room.name, { back: '#/chats' });
  view.classList.add('chatmode');
  const me = KF.state.me;
  let msgs = [], replyTo = null, editing = null, oldest = null, searchQ = '';
  const pending = new Set();

  view.innerHTML = `
    <div class="chat-head">
      <div class="grow small muted">${room.type === 'dm' ? '🔒 Private — only you two can see this' : room.type === 'planning' ? 'Discuss family plans here · <a href="#/plans">open Plans</a>' : room.type === 'shopping' ? 'Shared list · <a href="#/shopping">open Shopping lists</a>' : room.type === 'events' ? 'Event discussion · <a href="#/events">open Events</a>' : `${KF.state.members.length} member${KF.state.members.length === 1 ? '' : 's'}`}</div>
      <button class="icon-btn" data-s title="Search in chat">${icon('search')}</button>
      <button class="icon-btn" data-pins title="Pinned messages">${icon('pin')}</button>
      <button class="icon-btn" data-mute title="Mute">${room.muted ? '🔕' : '🔔'}</button></div>
    <div class="chat-head hidden" data-sbar><input placeholder="Search this chat…" data-q><button class="btn small ghost" data-sx>Close</button></div>
    <div class="chat-body" data-body></div>
    <div class="typing" data-typing></div>
    <div class="replybar hidden" data-rb><span class="grow" data-rt></span><button class="icon-btn" data-rx>✕</button></div>
    <div class="composer">
      <button class="icon-btn" data-att title="Attach">${icon('clip')}</button>
      <button class="icon-btn" data-emo title="Emoji">😊</button>
      <textarea rows="1" placeholder="Message" data-in aria-label="Message"></textarea>
      <button class="icon-btn" data-mic title="Voice message">${icon('mic')}</button>
      <button class="btn gold" data-send aria-label="Send">${icon('send')}</button></div>`;
  const body = $('[data-body]', view), input = $('[data-in]', view);

  const bubble = m => {
    const mine = m.userId === me.id, u = member(m.userId);
    let inner = '';
    if (m.deleted) return `<div class="msg deleted ${mine ? 'me' : ''}" data-id="${m.id}">Message deleted</div>`;
    if (!mine && room.type !== 'dm') inner += `<div class="who">${esc(u?.name || 'Former member')}</div>`;
    if (m.replyTo) { const r = msgs.find(x => x.id === m.replyTo); inner += `<div class="reply">${r ? esc((member(r.userId)?.name.split(' ')[0] || '') + ': ' + (r.deleted ? 'deleted' : r.text || 'attachment')) : 'Original message'}</div>`; }
    if (m.file) {
      const f = m.file, url = `/api/files/${f.id}/content`;
      if (f.mime.startsWith('image/')) inner += `<img class="att" loading="lazy" src="/api/files/${f.id}/thumb" onclick="window.open('${url}')" alt="${esc(f.name)}">`;
      else if (f.mime.startsWith('video/')) inner += `<video class="att" controls preload="metadata" src="${url}"></video>`;
      else if (f.mime.startsWith('audio/')) inner += `<audio controls preload="none" src="${url}" style="max-width:220px"></audio>`;
      else inner += `<a href="${url}" download="${esc(f.name)}" style="color:inherit">📄 ${esc(f.name)} <span class="small">(${fmtSize(f.size)})</span></a>`;
    }
    if (m.text) inner += `<div>${esc(m.text).replace(/@(\w+)/g, '<b>@$1</b>').replace(/\n/g, '<br>')}</div>`;
    const reacts = Object.entries(m.reactions || {}).filter(([, us]) => us.length);
    if (reacts.length) inner += `<div class="reacts">${reacts.map(([e, us]) => `<span data-react="${e}" title="${us.map(id => member(id)?.name || '').join(', ')}">${e} ${us.length}</span>`).join('')}</div>`;
    const read = mine && room.type === 'dm' ? (m.readBy && m.readBy.length ? '✓✓' : '✓') : (mine ? (m.readBy && m.readBy.length ? '✓✓' : '✓') : '');
    inner += `<div class="meta">${m.editedAt ? '<span>edited</span>' : ''}<span>${fmtTime(m.createdAt)}</span>${mine ? `<span style="color:${m.readBy?.length ? 'var(--gold)' : 'inherit'}">${read}</span>` : ''}</div>`;
    return `<div class="msg ${mine ? 'me' : ''} ${m.pinned ? 'pinned' : ''}" data-id="${m.id}">${inner}</div>`;
  };
  const render = (keepScroll) => {
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    let html = '', lastDay = '';
    if (!msgs.length) html = `<div class="empty"><div class="big">${ROOM_ICON[room.type] || '💬'}</div>${searchQ ? 'No messages match your search.' : 'No messages yet. Start the conversation!'}</div>`;
    for (const m of msgs) {
      const day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) { html += `<div class="day">${day === new Date().toDateString() ? 'Today' : fmtDate(m.createdAt)}</div>`; lastDay = day; }
      html += bubble(m);
    }
    body.innerHTML = html;
    if (!keepScroll || atBottom) body.scrollTop = body.scrollHeight;
  };
  const markRead = () => { if (document.visibilityState === 'visible') api(`/rooms/${roomId}/read`, { method: 'POST' }).then(() => { room.unread = 0; KF.updateBadges(); }).catch(() => {}); };

  async function load(q = '') {
    try {
      msgs = await api(`/rooms/${roomId}/messages${q ? '?q=' + encodeURIComponent(q) : ''}`);
      render(); if (!q) markRead();
    } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  await load();

  /* live updates */
  const offs = [
    KF.on('message.new', ev => { if (ev.message.roomId !== roomId || searchQ) return; if (msgs.some(m => m.id === ev.message.id)) return; msgs.push(ev.message); render(true); if (ev.message.userId !== me.id) markRead(); }),
    KF.on('message.update', ev => { if (ev.message.roomId !== roomId) return; const i = msgs.findIndex(m => m.id === ev.message.id); if (i >= 0) { msgs[i] = ev.message; render(true); } }),
    KF.on('read', ev => { if (ev.roomId !== roomId || ev.userId === me.id) return; msgs.forEach(m => { if (m.userId === me.id && m.id <= ev.upTo && !(m.readBy || []).includes(ev.userId)) (m.readBy = m.readBy || []).push(ev.userId); }); render(true); }),
    KF.on('typing', ev => { if (ev.roomId !== roomId || ev.userId === me.id) return; const t = $('[data-typing]', view); if (!t) return; t.textContent = `${member(ev.userId)?.name.split(' ')[0] || 'Someone'} is typing…`; clearTimeout(t._t); t._t = setTimeout(() => t.textContent = '', 2500); }),
    KF.on('open', () => { if (!searchQ) load(); }),
  ];
  KF.cleanup = () => { offs.forEach(f => f()); view.classList.remove('chatmode'); };

  /* send (with duplicate-submit protection via clientId) */
  async function send(extra = {}) {
    const text = input.value.trim();
    if (!text && !extra.fileId) return;
    if (editing) {
      try { await api('/messages/' + editing, { method: 'PATCH', body: { text } }); } catch (e) { toast(e.message); return; }
      editing = null; input.value = ''; $('[data-rb]', view).classList.add('hidden'); return;
    }
    const clientId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
    if (pending.has(clientId)) return; pending.add(clientId);
    const btn = $('[data-send]', view); btn.disabled = true;
    try {
      const m = await api(`/rooms/${roomId}/messages`, { method: 'POST', body: { text, replyTo: replyTo?.id || null, clientId, ...extra } });
      if (!msgs.some(x => x.id === m.id)) { msgs.push(m); render(); }
      input.value = ''; input.style.height = 'auto'; clearReply();
    } catch (e) { toast(e.offline ? 'Offline — message not sent. Try again when connected.' : e.message); }
    finally { pending.delete(clientId); btn.disabled = false; input.focus(); }
  }
  const clearReply = () => { replyTo = null; $('[data-rb]', view).classList.add('hidden'); };
  $('[data-send]', view).onclick = () => send();
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(min-width:700px)').matches) { e.preventDefault(); send(); } });
  let lastTyping = 0;
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 110) + 'px'; if (Date.now() - lastTyping > 2000) { lastTyping = Date.now(); KF.send({ type: 'typing', roomId }); } });
  $('[data-rx]', view).onclick = () => { clearReply(); editing = null; input.value = ''; };

  /* message actions */
  body.addEventListener('click', e => {
    const r = e.target.closest('[data-react]');
    const el = e.target.closest('.msg'); if (!el || e.target.closest('audio,video,a,img')) return;
    const m = msgs.find(x => x.id == el.dataset.id); if (!m) return;
    if (r) { api(`/messages/${m.id}/react`, { method: 'POST', body: { emoji: r.dataset.react } }).catch(x => toast(x.message)); return; }
    if (m.deleted) return;
    const mine = m.userId === me.id, canMod = me.role !== 'member';
    sheet(`<div class="row wrap" style="font-size:1.6rem;justify-content:center;margin-bottom:8px">${['👍', '❤️', '😂', '😮', '🙏', '🎉'].map(e => `<button class="icon-btn" data-e="${e}">${e}</button>`).join('')}</div>
      <div class="gap"><button class="btn ghost" data-a="reply">↩ Reply</button>
      ${m.text ? '<button class="btn ghost" data-a="copy">Copy</button>' : ''}
      <button class="btn ghost" data-a="pin">${m.pinned ? 'Unpin' : '📌 Pin'}</button>
      ${mine && m.text ? '<button class="btn ghost" data-a="edit">✏️ Edit</button>' : ''}
      ${mine || canMod ? '<button class="btn danger" data-a="del">Delete</button>' : ''}</div>`, (s, close) => {
      $$('[data-e]', s).forEach(b => b.onclick = () => { close(); api(`/messages/${m.id}/react`, { method: 'POST', body: { emoji: b.dataset.e } }).catch(x => toast(x.message)); });
      $$('[data-a]', s).forEach(b => b.onclick = async () => {
        close(); const a = b.dataset.a;
        if (a === 'reply') { replyTo = m; $('[data-rt]', view).textContent = '↩ ' + (member(m.userId)?.name.split(' ')[0] || '') + ': ' + (m.text || 'attachment'); $('[data-rb]', view).classList.remove('hidden'); input.focus(); }
        else if (a === 'copy') { navigator.clipboard?.writeText(m.text); toast('Copied'); }
        else if (a === 'pin') api(`/messages/${m.id}/pin`, { method: 'POST' }).catch(x => toast(x.message));
        else if (a === 'edit') { editing = m.id; input.value = m.text; $('[data-rt]', view).textContent = '✏️ Editing message'; $('[data-rb]', view).classList.remove('hidden'); input.focus(); }
        else if (a === 'del' && await confirmSheet('Delete this message for everyone?', 'Delete', true)) api('/messages/' + m.id, { method: 'DELETE' }).catch(x => toast(x.message));
      });
    });
  });

  /* header actions */
  $('[data-mute]', view).onclick = async function () {
    try { const r = await api(`/rooms/${roomId}/mute`, { method: 'POST', body: { muted: !room.muted } }); room.muted = r.muted; this.textContent = r.muted ? '🔕' : '🔔'; toast(r.muted ? 'Chat muted' : 'Chat unmuted'); KF.updateBadges(); } catch (e) { toast(e.message); }
  };
  $('[data-pins]', view).onclick = () => { const p = msgs.filter(m => m.pinned && !m.deleted); sheet(`<h2>📌 Pinned</h2>${p.length ? p.map(m => `<div class="card" style="margin-bottom:8px"><div class="small muted">${esc(member(m.userId)?.name || '')} · ${fmtDT(m.createdAt)}</div>${esc(m.text || 'attachment')}</div>`).join('') : '<div class="empty">No pinned messages. Tap a message to pin it.</div>'}`); };
  const sbar = $('[data-sbar]', view);
  $('[data-s]', view).onclick = () => { sbar.classList.toggle('hidden'); $('[data-q]', view).focus(); };
  $('[data-sx]', view).onclick = () => { sbar.classList.add('hidden'); searchQ = ''; $('[data-q]', view).value = ''; load(); };
  let st; $('[data-q]', view).oninput = e => { clearTimeout(st); st = setTimeout(() => { searchQ = e.target.value.trim(); load(searchQ); }, 300); };

  /* emoji / stickers */
  $('[data-emo]', view).onclick = () => sheet(`<h2>Emoji &amp; stickers</h2><div class="row wrap" style="font-size:1.7rem">${EMOJIS.map(e => `<button class="icon-btn" data-ch="${e}">${e}</button>`).join('')}</div>
    <h3 style="margin:12px 0 4px">Stickers</h3><div class="row wrap" style="font-size:2.6rem">${STICKERS.map(e => `<button class="icon-btn" data-st="${e}">${e}</button>`).join('')}</div>`, (s, close) => {
    $$('[data-ch]', s).forEach(b => b.onclick = () => { input.value += b.dataset.ch; input.focus(); });
    $$('[data-st]', s).forEach(b => b.onclick = () => { close(); const t = input.value; input.value = b.dataset.st; send().then(() => { input.value = t; }); });
  });

  /* attachments */
  $('[data-att]', view).onclick = async () => {
    const [file] = await pickFile('image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.zip');
    if (!file) return; await sendFile(file);
  };
  async function sendFile(file) {
    toast('Uploading…');
    try {
      const f = await uploadFile(file, room.type === 'dm' ? 'chat' : room.type === 'planning' ? 'plans' : room.type === 'events' ? 'events' : room.type === 'shopping' ? 'shopping' : 'chat', { roomId });
      await send({ fileId: f.id });
    } catch (e) { toast(e.message); }
  }

  /* voice messages (MediaRecorder; needs microphone permission) */
  let rec = null, chunks = [];
  $('[data-mic]', view).onclick = async function () {
    if (rec) { rec.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Voice recording is not supported in this browser'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec = new MediaRecorder(stream); chunks = [];
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop()); this.style.color = ''; const mime = rec.mimeType || 'audio/webm'; rec = null;
        const blob = new Blob(chunks, { type: mime });
        if (blob.size < 800) return;
        await sendFile(new File([blob], `voice-${Date.now()}.${mime.includes('mp4') ? 'm4a' : 'webm'}`, { type: mime }));
      };
      rec.start(); this.style.color = 'var(--danger)'; toast('Recording… tap the mic again to send');
    } catch (e) { toast('Microphone permission denied'); }
  };
};

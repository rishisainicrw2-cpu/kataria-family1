/* HINDU ESPORTS — core helpers: state, API client, WebSocket, UI utilities */
const KF = window.KF = { state: { me: null, family: null, members: [], rooms: [], unread: {}, online: new Set() }, views: {}, ws: null, handlers: {} };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

/* inline icon set (stroke icons) */
const IC = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z"/>',
  chat: '<path d="M21 12a8 8 0 01-11.5 7.2L3 21l1.8-6A8 8 0 1121 12z"/>',
  plans: '<path d="M9 11l3 3 8-8M4 5h6M4 12h4M4 19h14"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  clip: '<path d="M21 12l-9 9a6 6 0 01-9-9l9-9a4 4 0 016 6l-9 9a2 2 0 01-3-3l8-8"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l3 12h11l2-8H6"/>',
  money: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9a3 3 0 00-5 1c0 3 5 2 5 5a3 3 0 01-5 1M12 6v2M12 16v2"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
  bell: '<path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8M10 21a2 2 0 004 0"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1.3l2-1.6-2-3.4-2.4 1a7 7 0 00-2.2-1.3L14 3h-4l-.3 2.4a7 7 0 00-2.2 1.3l-2.4-1-2 3.4 2 1.6A7 7 0 005 12c0 .4 0 .9.1 1.3l-2 1.6 2 3.4 2.4-1a7 7 0 002.2 1.3L10 21h4l.3-2.4a7 7 0 002.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  poll: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  folder: '<path d="M3 6a2 2 0 012-2h4l2 3h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  pin: '<path d="M12 17v5M8 3h8l-1 7 3 3H6l3-3z"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  drive: '<path d="M8 3h8l6 10-4 7H6l-4-7z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 115 0c0 2-2.5 2-2.5 4M12 17v.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0114 0M17 5a3.5 3.5 0 010 7M22 20a6 6 0 00-4-5.6"/>',
  invite: '<path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM19 8v6M22 11h-6"/>',
};
const icon = (n, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${IC[n] || ''}</svg>`;

/* API client — cookies carry the session; never any token in JS */
async function api(path, opts = {}) {
  const o = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body instanceof FormData) o.body = opts.body;
  else if (opts.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  let res;
  try { res = await fetch('/api' + path, o); }
  catch (e) { const err = new Error('You appear to be offline. Please check your connection.'); err.offline = true; throw err; }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status; err.code = data && data.code;
    if (res.status === 401 && KF.state.me) { KF.state.me = null; KF.showAuth && KF.showAuth(); }
    throw err;
  }
  return data;
}
KF.api = api;

/* toast */
let toastT;
function toast(msg) {
  let t = $('#toast'); if (!t) { t = h('<div id="toast"></div>'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 2800);
}

/* bottom sheet */
function sheet(html, onMount) {
  const bg = h(`<div class="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`);
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  $('#overlay').appendChild(bg);
  onMount && onMount($('.sheet', bg), close);
  return close;
}
function confirmSheet(msg, okLabel = 'Confirm', danger = false) {
  return new Promise(res => {
    sheet(`<h2>${esc(msg)}</h2><div class="row"><button class="btn ghost grow" data-n>Cancel</button><button class="btn ${danger ? 'danger' : ''} grow" data-y>${esc(okLabel)}</button></div>`,
      (el, close) => { $('[data-n]', el).onclick = () => { close(); res(false); }; $('[data-y]', el).onclick = () => { close(); res(true); }; });
  });
}
/* form sheet: fields = [{name,label,type,value,options,required,placeholder}] */
function formSheet(title, fields, submitLabel = 'Save') {
  return new Promise(res => {
    const body = fields.map(f => {
      const v = f.value ?? '';
      let input;
      if (f.type === 'select') input = `<select name="${f.name}">${(f.options || []).map(o => `<option value="${esc(o.value ?? o)}" ${(o.value ?? o) == v ? 'selected' : ''}>${esc(o.label ?? o)}</option>`).join('')}</select>`;
      else if (f.type === 'textarea') input = `<textarea name="${f.name}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
      else input = `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" ${f.step ? `step="${f.step}"` : ''} ${f.required ? 'required' : ''}>`;
      return `<label>${esc(f.label)}</label>${input}`;
    }).join('');
    sheet(`<h2>${esc(title)}</h2><form>${body}<div class="err small" style="color:var(--danger);min-height:1.2em"></div><div class="row" style="margin-top:10px"><button type="button" class="btn ghost grow" data-n>Cancel</button><button class="btn grow gold">${esc(submitLabel)}</button></div></form>`,
      (el, close) => {
        $('[data-n]', el).onclick = () => { close(); res(null); };
        $('form', el).onsubmit = e => {
          e.preventDefault();
          const out = {};
          for (const f of fields) {
            let val = $(`[name="${f.name}"]`, el).value.trim();
            if (f.required && !val) { $('.err', el).textContent = `${f.label} is required`; return; }
            out[f.name] = val;
          }
          close(); res(out);
        };
        const first = $('input,textarea,select', el); first && first.focus();
      });
  });
}

/* formatting */
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDate = t => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDT = t => `${new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${fmtTime(t)}`;
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const money = n => (KF.state.family?.currency || '₹') + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const member = id => KF.state.members.find(m => m.id === id);
function avatar(u, cls = '') {
  if (!u) return `<span class="avatar ${cls}">?</span>`;
  const online = KF.state.online.has(u.id) ? '<i class="dot"></i>' : '';
  const inner = u.hasPhoto ? `<img src="/api/users/${u.id}/photo?v=${u.photoV || 0}" alt="">` : esc(initials(u.name));
  return `<span class="avatar ${cls}">${inner}${online}</span>`;
}
function localISO(d = new Date()) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }

/* theme */
function applyTheme() {
  const pref = (KF.state.me && KF.state.me.prefs && KF.state.me.prefs.theme) || localStorage.getItem('kf_theme') || 'dark';
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const accent = KF.state.family && KF.state.family.accent;
  if (accent) document.documentElement.style.setProperty('--accent', accent); else document.documentElement.style.removeProperty('--accent');
  document.querySelector('meta[name=theme-color]').content = dark ? '#000000' : '#a63a05';
}
KF.applyTheme = applyTheme;

/* WebSocket with auto-reconnect; the session cookie authenticates the upgrade */
function connectWS() {
  if (KF.ws && KF.ws.readyState <= 1) return;
  const ws = KF.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { KF.wsRetry = 0; $('#offline') && $('#offline').classList.add('hidden'); (KF.handlers.open || []).forEach(f => f()); };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } (KF.handlers[m.type] || []).forEach(f => f(m)); };
  ws.onclose = () => {
    if (!KF.state.me) return;
    $('#offline') && $('#offline').classList.remove('hidden');
    KF.wsRetry = Math.min((KF.wsRetry || 0) + 1, 6);
    setTimeout(connectWS, 800 * KF.wsRetry);
  };
}
KF.connectWS = connectWS;
KF.on = (type, fn) => { (KF.handlers[type] = KF.handlers[type] || []).push(fn); return () => { KF.handlers[type] = KF.handlers[type].filter(f => f !== fn); }; };
KF.send = obj => { if (KF.ws && KF.ws.readyState === 1) KF.ws.send(JSON.stringify(obj)); };
window.addEventListener('online', () => { connectWS(); });
window.addEventListener('offline', () => { $('#offline') && $('#offline').classList.remove('hidden'); });

/* upload helper — files go to the server, which stores them in Google Drive */
async function uploadFile(file, category, extra = {}) {
  const fd = new FormData();
  fd.append('category', category);
  Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
  fd.append('file', file, file.name);
  return api('/files', { method: 'POST', body: fd });
}
function pickFile(accept, multiple = false) {
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept || '*/*'; i.multiple = multiple;
    i.onchange = () => res([...i.files]); i.click();
  });
}
Object.assign(window, { $, $$, esc, h, icon, toast, sheet, confirmSheet, formSheet, fmtTime, fmtDate, fmtDT, fmtSize, money, initials, member, avatar, localISO, uploadFile, pickFile, api });

// Player Recruitment — public page, no login. Talks to /api/recruitment/* only.
(() => {
  async function api(path, opts = {}) {
    const r = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || 'Something went wrong. Please try again.');
    return data;
  }
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  // ---- tabs ----
  $$('.tab').forEach(t => t.onclick = () => {
    $$('.tab').forEach(x => x.classList.remove('on')); t.classList.add('on');
    const apply = t.dataset.tab === 'apply';
    $('#applyPane').classList.toggle('hidden', !apply);
    $('#statusPane').classList.toggle('hidden', apply);
  });

  // ---- apply form ----
  const form = $('#applyForm'), applyBtn = $('#applyBtn'), applyErr = $('#applyErr');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    applyErr.textContent = '';
    const fd = new FormData(form);
    const body = {
      fullName: fd.get('fullName'), ign: fd.get('ign'), bgmiUid: fd.get('bgmiUid'),
      age: fd.get('age') || undefined, role: fd.get('role'), experience: fd.get('experience'),
      previousTeam: fd.get('previousTeam'), preferredTeam: fd.get('preferredTeam'),
      device: fd.get('device'), hours: fd.get('hours'), contact: fd.get('contact'),
      socialLink: fd.get('socialLink'), consent: fd.get('consent') === 'on',
    };
    applyBtn.disabled = true; applyBtn.innerHTML = '<span class="spinner"></span>Submitting…';
    try {
      const r = await api('/recruitment/apply', { method: 'POST', body });
      form.classList.add('hidden');
      $('#appIdCode').textContent = r.applicationId;
      $('#appIdBox').classList.remove('hidden');
    } catch (err) {
      applyErr.textContent = err.message;
      applyBtn.disabled = false; applyBtn.textContent = 'Submit application';
    }
  });
  $('#copyBtn').onclick = () => {
    navigator.clipboard?.writeText($('#appIdCode').textContent);
    $('#copyBtn').textContent = 'Copied!'; setTimeout(() => $('#copyBtn').textContent = 'Copy', 1500);
  };

  // ---- status check ----
  const statusBtn = $('#statusBtn'), statusErr = $('#statusErr'), statusResult = $('#statusResult'), statusCode = $('#statusCode');
  async function checkStatus() {
    const code = statusCode.value.trim();
    statusErr.textContent = ''; statusResult.classList.add('hidden');
    if (!code) { statusErr.textContent = 'Enter your Application ID.'; return; }
    statusBtn.disabled = true; statusBtn.innerHTML = '<span class="spinner"></span>Checking…';
    try {
      const a = await api('/recruitment/status/' + encodeURIComponent(code));
      statusResult.innerHTML = `
        <div class="center" style="margin-bottom:14px"><span class="pill ${a.status}">${a.statusLabel}</span></div>
        <div class="statusrow"><span class="muted">Applicant</span><b>${esc(a.fullName)}</b></div>
        <div class="statusrow"><span class="muted">IGN</span><b>${esc(a.ign)}</b></div>
        <div class="statusrow"><span class="muted">Role</span><b>${esc(a.role)}</b></div>
        <div class="statusrow"><span class="muted">Preferred team</span><b>${esc(a.preferredTeamLabel)}</b></div>
        <div class="statusrow"><span class="muted">Submitted</span><b>${new Date(a.submittedAt).toLocaleDateString()}</b></div>`;
      statusResult.classList.remove('hidden');
    } catch (err) {
      statusErr.textContent = err.message;
    } finally {
      statusBtn.disabled = false; statusBtn.textContent = 'Check status';
    }
  }
  statusBtn.onclick = checkStatus;
  statusCode.addEventListener('keydown', e => { if (e.key === 'Enter') checkStatus(); });

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
})();

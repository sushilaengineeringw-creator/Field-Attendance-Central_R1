'use strict';
/* Field Attendance App - ONE app for three roles (employee / manager / company admin) plus the owner console.
   Talks to the central Google Apps Script backend. All licence / time / duplicate / permission decisions are made on the server.
   Employee check-in keeps the proven v2.5 engine: GPS starts while the front camera is open, 800 px photo, best-of GPS, idempotent submit. */
const $app = document.getElementById('app'), $nav = document.getElementById('nav');
const showFatal = (m) => { if (!$app.innerHTML.trim()) $app.innerHTML = '<div class="card"><div class="banner bad">App error: ' + String(m).replace(/[<>&]/g, '') + '<br>Please install the latest APK or contact support.</div></div>'; };
window.addEventListener('error', (e) => showFatal(e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason && e.reason.message || e.reason));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: (k) => { try { localStorage.removeItem(k); } catch {} } };
const serverUrl = () => (store.get('server_url') || window.APP_CONFIG.SERVER_URL).trim();
const APP_VERSION = '3.0';
const cap = window.Capacitor;
const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
// Talks to the native Camera / Geolocation / Browser / Filesystem / Share plugins through the Capacitor bridge that Android injects
// into the page (cap.nativePromise / cap.nativeCallback). This needs no bundler and no extra script files.
const plugin = (name) => {
  if (!isNative || !cap.nativePromise || !cap.nativeCallback) return null;
  return new Proxy({}, { get: (_, m) => {
    if (m === 'then') return undefined;
    if (m === 'watchPosition') return (opts, cb) => Promise.resolve(cap.nativeCallback(name, m, opts || {}, cb));   // resolves to a watch id
    return (opts) => cap.nativePromise(name, m, opts || {});
  } });
};


const S = { token: null, role: null, user: null, company: null, me: null, offset: 0, timer: null, poll: null, tab: 'dash' };

class ApiError extends Error { constructor(m, code, data) { super(m); this.code = code; this.data = data; } }
async function rawCall(action, payload = {}) {
  let res;
  try { res = await fetch(serverUrl(), { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, ...payload }) }); }
  catch { throw new ApiError('Cannot reach the server. Check your internet connection. Nothing was recorded.', 'NETWORK'); }
  let data; try { data = await res.json(); } catch { throw new ApiError('Unexpected reply from the server. Check the server address in the app build.', 'BAD_REPLY'); }
  if (data.server_time) S.offset = new Date(data.server_time) - Date.now();
  if (data.ok) return data;
  throw new ApiError(data.message || 'Request failed', data.error, data);
}
function applyLogin(r) { S.token = r.token; S.role = r.role; S.user = r.user || null; S.company = r.company || null; }
async function relogin() {
  const co = store.get('co'), id = store.get('uid'), pin = store.get('pin');
  if (!co || !id || !pin) throw new ApiError('Please sign in again.', 'SESSION_EXPIRED');
  const r = id === 'OWNER' ? await rawCall('owner_login', { password: pin }) : await rawCall('login', { company_id: co, id, pin }); applyLogin(r); return r;
}
async function call(action, payload = {}) {
  if (!S.token) await relogin().catch((e) => authFailed(e));
  try { return await rawCall(action, { token: S.token, ...payload }); }
  catch (e) {
    if (e.code === 'SESSION_EXPIRED') { try { await relogin(); return await rawCall(action, { token: S.token, ...payload }); } catch (e2) { return authFailed(e2); } }
    if (/^AUTH_/.test(e.code || '') || (/^LICENCE_/.test(e.code || '') && S.role !== 'ADMIN' && S.role !== 'OWNER')) return authFailed(e);
    throw e;
  }
}
function authFailed(e) { if (e.code === 'NETWORK' || e.code === 'BAD_REPLY') throw e; stopTimers(); store.del('pin'); S.token = null; showLogin(e.message); throw e; }
const serverNow = () => new Date(Date.now() + S.offset);
const fmtDate = (d) => { const [y, m, dd] = String(d).split('-'); return `${dd}/${m}/${y}`; };
const dur = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return String(Math.floor(m / 60)).padStart(2, '0') + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
const mapLink = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;
const todayIST = () => new Date(Date.now() + S.offset).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const g = (id) => document.getElementById(id);
const val = (id) => (g(id) ? g(id).value.trim() : '');
function stopTimers() { clearInterval(S.timer); clearInterval(S.poll); }
function openUrl(url) { const B = plugin('Browser'); if (B) return B.open({ url }); window.open(url, '_blank'); }
function setHeader(who) { g('who').textContent = who || ''; }
function busy(btn, text, fn) { const old = btn.textContent; btn.disabled = true; btn.textContent = text; return Promise.resolve().then(fn).finally(() => { if (document.body.contains(btn)) { btn.disabled = false; btn.textContent = old; } }); }
function toast(m, bad) { alert((bad ? '' : '') + m); }
function modal(html) { const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = '<div class="box">' + html + '</div>'; document.body.appendChild(m); m.close = () => m.remove(); m.addEventListener('click', (e) => { if (e.target === m) m.remove(); }); return m; }

// ---------------- sign in / register ----------------
function showLogin(msg) {
  stopTimers(); setHeader(''); $nav.innerHTML = ''; $app.className = '';
  $app.innerHTML = `<div class="card"><h2 style="margin:0 0 4px">Sign in</h2><div class="small">Employees, managers and company administrators</div>
    ${msg ? `<div class="banner bad" style="margin-top:12px">${esc(msg)}</div>` : ''}
    <label>Company ID</label><input id="co" autocapitalize="characters" value="${esc(store.get('co') || '')}">
    <label>User ID <span class="small">(Employee ID, or ADMIN for the company administrator)</span></label><input id="u" autocapitalize="characters" autocomplete="username" value="${esc(store.get('uid') === 'OWNER' ? '' : (store.get('uid') || ''))}">
    <label>PIN / Password</label><input id="p" type="password" autocomplete="current-password">
    <button id="go">Sign in</button><div id="err" class="banner bad hidden" style="margin-top:12px"></div></div>
    <button class="ghost" id="reg">Register your company</button>
    <div style="text-align:center;margin-top:18px"><a href="#" id="own" class="small">Owner sign-in</a></div>
    <div class="small" style="margin-top:12px;text-align:center">App v${APP_VERSION} · ${isNative ? 'phone app' : 'browser'}</div>`;
  g('reg').onclick = showRegister; g('own').onclick = (e) => { e.preventDefault(); showOwnerLogin(); };
  g('go').onclick = async () => {
    const b = g('go'), err = g('err'); err.classList.add('hidden');
    const co = val('co').toUpperCase(), id = val('u').toUpperCase(), pin = val('p');
    await busy(b, 'Signing in…', async () => {
      try { const r = await rawCall('login', { company_id: co, id, pin }); applyLogin(r); store.set('co', co); store.set('uid', id); store.set('pin', pin); goHome(); }
      catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    });
  };
}
function showRegister(msg) {
  $app.innerHTML = `<div class="card"><h2 style="margin:0 0 4px">Register your company</h2><div class="small">Free trial. Your attendance sheet and photos are created in <b>your own Google account</b> after you sign in with Google.</div>
    ${typeof msg === 'string' && msg ? `<div class="banner bad" style="margin-top:12px">${esc(msg)}</div>` : ''}
    <label>Company name</label><input id="r_co"><label>Administrator name</label><input id="r_nm"><label>Mobile number</label><input id="r_mb" inputmode="tel">
    <label>Email address</label><input id="r_em" type="email"><label>Administrator password (6-20 letters/numbers)</label><input id="r_pw" type="password">
    <label>Business type</label><select id="r_bt"><option>Service company</option><option>Engineering company</option><option>Field sales</option><option>Solar installation</option><option>Marketing</option><option>Maintenance</option><option>Industrial service</option><option>Other</option></select>
    <label>Number of employees</label><input id="r_n" inputmode="numeric"><label>Address</label><input id="r_ad">
    <button id="r_go">Continue with Google</button><button class="ghost" id="r_bk">Back</button></div>`;
  g('r_bk').onclick = () => showLogin();
  g('r_go').onclick = () => busy(g('r_go'), 'Please wait…', async () => {
    try {
      const r = await rawCall('register_start', { company_name: val('r_co'), admin_name: val('r_nm'), mobile: val('r_mb'), email: val('r_em'), admin_pin: val('r_pw'), business_type: val('r_bt'), employees: val('r_n'), address: val('r_ad') });
      store.set('co', r.company_id); store.set('uid', 'ADMIN'); waitRegistration(r);
    } catch (e) { showRegister(e.message); }
  });
}
function waitRegistration(r) {
  $app.innerHTML = `<div class="card"><h3 style="margin:0">Sign in with Google</h3><div class="small" style="margin-top:6px">Sign in with the Google account that should <b>own</b> this company's attendance sheet and photos, and tap <b>Allow</b>. The app only gets access to the files it creates.</div>
    <div id="rs" class="banner info" style="margin-top:12px">Waiting for Google sign-in…</div><button id="again">Open Google sign-in</button><button class="ghost" id="cn">Cancel</button></div>`;
  const open = () => openUrl(r.auth_url); g('again').onclick = open; g('cn').onclick = () => { clearInterval(S.poll); showLogin(); }; open();
  clearInterval(S.poll);
  const check = async () => {
    try {
      const s = await rawCall('register_status', { company_id: r.company_id });
      if (s.status === 'READY') { clearInterval(S.poll); registrationDone(r.company_id); }
      else if (s.status === 'ERROR' && g('rs')) { g('rs').className = 'banner bad'; g('rs').textContent = s.message || 'Google sign-in did not finish. Tap "Open Google sign-in" to try again.'; }
    } catch {}
  };
  S.poll = setInterval(check, 3000); document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); }, { once: true });
}
function registrationDone(cid) {
  $app.innerHTML = `<div class="banner ok"><b>✓ Company registered</b></div><div class="card" style="text-align:center"><div class="small">Your Company ID</div><div style="font-size:34px;font-weight:800;color:var(--navy);letter-spacing:2px">${esc(cid)}</div>
    <div class="small" style="margin-top:8px">Write it down. Employees need it to sign in. Sign in yourself with User ID <b>ADMIN</b> and the password you chose.</div></div>
    <button id="ok">Sign in now</button>`;
  g('ok').onclick = () => showLogin();
}

// Collects GPS readings for up to 15 s and keeps the most accurate one. Any accuracy is accepted and recorded.
async function getLocation() {
  const G = plugin('Geolocation');
  if (isNative && !G) throw new Error('GPS component is missing in this app build. Please install the latest APK.');
  const pack = (p) => ({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, loc_age_s: Math.max(0, (Date.now() - p.timestamp) / 1000) });
  const WAIT_MS = 12000, GOOD_M = 25, EARLY_MS = 5000, EARLY_M = 50, t0 = Date.now();
  try {
    if (G) {
      const perm = await G.checkPermissions();
      if (perm.location !== 'granted') { const r = await G.requestPermissions(); if (r.location !== 'granted') throw new Error('Location permission is denied. Enable it in Settings > Apps > VATS Attendance > Permissions > Location.'); }
    }
    return await new Promise((resolve, reject) => {
      let best = null, done = false, id = null, timer = null;
      const stop = async () => { try { if (id !== null) { if (G) await G.clearWatch({ id }); else navigator.geolocation.clearWatch(id); } } catch {} };
      const finish = (err) => { if (done) return; done = true; clearTimeout(timer); stop(); best ? resolve(pack(best)) : reject(err || new Error('No GPS fix received')); };
      timer = setTimeout(() => finish(), WAIT_MS); setTimeout(() => { if (!done && best && best.coords.accuracy <= EARLY_M) finish(); }, EARLY_MS);
      const onPos = (pos, err) => {
        if (done) return;
        if (err || !pos) { if (!best) finish(err instanceof Error ? err : new Error((err && err.message) || 'GPS error')); return; }
        if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        if (best.coords.accuracy <= GOOD_M || (Date.now() - t0 >= EARLY_MS && best.coords.accuracy <= EARLY_M)) finish();
      };
      const start = G
        ? G.watchPosition({ enableHighAccuracy: true, timeout: WAIT_MS, maximumAge: 0 }, onPos)
        : Promise.resolve(navigator.geolocation.watchPosition((p) => onPos(p), (e) => onPos(null, e), { enableHighAccuracy: true, timeout: WAIT_MS, maximumAge: 0 }));
      start.then((wid) => { id = wid; if (done) stop(); }).catch((e) => finish(e));
    });
  } catch (e) { throw new Error(/denied|permission/i.test(e.message) ? e.message : 'Could not get your location. Turn ON Location (GPS) on your phone and try again. ' + (e.message || '')); }
}
async function takePhoto() {   // returns a data URL (jpeg) or null if cancelled. Live camera only; gallery is never offered.
  const C = plugin('Camera');
  if (isNative && !C) throw new Error('Camera component is missing in this app build. Please install the latest APK.');
  if (C) {
    try {
      const perm = await C.checkPermissions(); if (perm.camera !== 'granted') { const r = await C.requestPermissions({ permissions: ['camera'] }); if (r.camera !== 'granted') throw new Error('Camera permission is denied. Enable it in Settings > Apps > VATS Attendance > Permissions.'); }
      const ph = await C.getPhoto({ quality: 60, width: 800, resultType: 'base64', source: 'CAMERA', direction: 'FRONT', correctOrientation: true, saveToGallery: false });
      return 'data:image/' + (ph.format === 'png' ? 'png' : 'jpeg') + ';base64,' + ph.base64String;
    } catch (e) { if (/cancel/i.test(e.message)) return null; throw e; }
  }
  return await new Promise((ok) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.setAttribute('capture', 'user');
    i.onchange = () => { const f = i.files[0]; if (!f) return ok(null); const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); }; i.click(); });
}
// Resize to 800px wide and burn the information band into the picture before upload.
function stamp(dataUrl, lines) {
  return new Promise((ok, no) => {
    const img = new Image(); img.onerror = () => no(new Error('Could not read the photo. Please retake.'));
    img.onload = () => {
      const w = Math.min(800, img.width), h = Math.round(img.height * w / img.width), c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h);
      const fs = Math.max(Math.round(w / 34), 13), lh = Math.round(fs * 1.35), bh = lh * lines.length + 14;
      x.fillStyle = 'rgba(0,0,0,0.62)'; x.fillRect(0, h - bh, w, bh); x.fillStyle = '#fff'; x.font = fs + 'px sans-serif'; x.textBaseline = 'top';
      lines.forEach((t, i) => x.fillText(t, 10, h - bh + 8 + i * lh));
      ok(c.toDataURL('image/jpeg', 0.6));
    };
    img.src = dataUrl;
  });
}


let flow = null;   // one idempotency key per check-in attempt so retries never create duplicates
async function startCheckIn() {
  try {
    // Speed: start finding the location NOW, while the person is taking the photo (both happen at the same time).
    const key = flow && flow.key ? flow.key : (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    const keep = flow && flow.loc && Date.now() - flow.locAt < 120000 ? flow : null;   // retake: reuse a fresh location
    flow = { raw: null, key, loc: keep ? keep.loc : null, locAt: keep ? keep.locAt : 0, busy: null, err: '' };
    const f = flow;
    if (!f.loc) { try { await ensureLocPermission(); acquireLocation(); } catch (e) { f.err = e.message; } }
    const p = await takePhoto();
    if (!p) { if (flow === f) flow = null; return; }
    f.raw = p; renderPreview();
  } catch (e) { alert(e.message); }
}
async function ensureLocPermission() {
  const G = plugin('Geolocation'); if (!G) return;
  const perm = await G.checkPermissions();
  if (perm.location !== 'granted') { const r = await G.requestPermissions(); if (r.location !== 'granted') throw new Error('Location permission is denied. Enable it in Settings > Apps > VATS Attendance > Permissions > Location.'); }
}
function acquireLocation() {
  const f = flow; if (!f) return Promise.resolve();
  if (f.busy) return f.busy;
  f.err = ''; f.loc = null; setLocStatus();
  f.busy = getLocation().then((l) => { f.loc = l; f.locAt = Date.now(); }).catch((e) => { f.err = e.message; }).finally(() => { f.busy = null; if (flow === f) setLocStatus(); });
  return f.busy;
}
function setLocStatus() {
  const el = document.getElementById('locst'); if (!el || !flow) return;
  if (flow.busy) el.innerHTML = '📍 Getting your location… (a few seconds)';
  else if (flow.loc) el.innerHTML = `📍 Location ready — accuracy about ${Math.round(flow.loc.accuracy)} m`;
  else el.innerHTML = `<span style="color:#c62828">📍 ${esc(flow.err || 'Location not received.')}</span> <a href="#" id="retryloc">Try again</a>`;
  const r = document.getElementById('retryloc'); if (r) r.onclick = (e) => { e.preventDefault(); acquireLocation(); };
}
function renderPreview(msg) {
  $app.innerHTML = `<div class="card"><h3 style="margin:0">Confirm your photo</h3><img class="thumb" src="${flow.raw}">
    <div id="locst" class="small" style="margin-top:10px;font-size:14px"></div>
    ${msg ? `<div class="banner bad" style="margin-top:12px">${esc(msg)}</div>` : ''}
    <button class="green" id="sub">Submit attendance</button><button class="ghost" id="rt">Retake photo</button><button class="ghost" id="cn">Cancel</button></div>`;
  document.getElementById('cn').onclick = () => { flow = null; goHome(); };
  document.getElementById('rt').onclick = startCheckIn;
  setLocStatus();
  if (!flow.loc && !flow.busy) acquireLocation();
  document.getElementById('sub').onclick = async (ev) => {
    const b = ev.target; b.disabled = true;
    try {
      if (flow.loc && Date.now() - flow.locAt > 180000) flow.loc = null;       // location older than 3 minutes: take a new one
      if (!flow.loc) { b.textContent = 'Getting your location…'; await acquireLocation(); }
      if (!flow.loc) throw new Error(flow.err || 'Location not received. Turn ON Location (GPS) and try again.');
      b.textContent = 'Submitting…'; const loc = flow.loc;
      const e = S.user, now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      const photo = await stamp(flow.raw, [`${e.name} (${e.id})`, `${e.designation || ''}${e.designation && e.site ? ' | ' : ''}${e.site || ''}`, now, `Lat ${loc.lat.toFixed(6)}  Long ${loc.lng.toFixed(6)}  (+/-${Math.round(loc.accuracy)} m)`].filter(Boolean));
      const r = await call('checkin', { ...loc, idem: flow.key, photo: photo.split(',')[1] });
      flow = null; showResult('Attendance recorded', r, photo);
    } catch (er) { const sb = document.getElementById('sub'); if (!sb) return;   // page already replaced (e.g. signed out)
      b.disabled = false; b.textContent = 'Submit attendance'; const m = document.querySelector('#app .banner.bad'); if (m) m.remove(); sb.insertAdjacentHTML('beforebegin', `<div class="banner bad" style="margin-top:12px">${esc(er.message)}</div>`); }
  };
}
async function doCheckOut() {
  if (!confirm('Log out of your attendance session now?')) return;
  const b = document.getElementById('out'); b.disabled = true; b.textContent = 'Getting your location…';
  try {
    const loc = await getLocation(); b.textContent = 'Submitting…';
    showResult('Logged out', await call('checkout', { ...loc, idem: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) }));
  } catch (e) { alert(e.message); b.disabled = false; b.textContent = 'LOG OUT / CHECK OUT'; }
}

function showResult(title, r, img) {
  const s = r.session, out = !!s.out_time, lat = out ? s.out_lat : s.in_lat, lng = out ? s.out_lng : s.in_lng;
  $app.innerHTML = `<div class="banner ok"><b>✓ ${title}</b> — saved to the company attendance sheet.</div>${r.warning ? `<div class="banner warn">${esc(r.warning)}</div>` : ''}
    <div class="card"><div class="row"><span>Reference</span><b>${esc(s.ref)}</b></div><div class="row"><span>Site</span><span>${esc(s.site || '—')}</span></div>
    <div class="row"><span>Check-in</span><span>${fmtDate(s.date)} ${esc(s.in_time)}</span></div>
    ${out ? `<div class="row"><span>Check-out</span><span>${esc(s.out_time)}</span></div><div class="row"><span>Working hours</span><b>${esc(s.duration)}</b></div>` : ''}
    <div class="row"><span>Location</span><a href="${mapLink(lat, lng)}" target="_blank" rel="noopener">${lat.toFixed(5)}, ${lng.toFixed(5)}</a></div>
    <div class="row"><span>GPS accuracy</span><span>about ${Math.round(Number(out ? s.out_acc : s.in_acc) || 0)} m</span></div>${img ? `<img class="thumb" src="${img}">` : ''}</div>
    <button id="ok">Done</button>`;
  g('ok').onclick = goHome;
}
async function showHistory() {
  try {
    const { sessions } = await call('history');
    $app.innerHTML = `<div class="card"><h3 style="margin:0 0 6px">Attendance history</h3>${sessions.map(s => `<div class="hist"><b>${fmtDate(s.date)}</b> &nbsp; IN ${esc(s.in_time)} → ${s.out_time ? 'OUT ' + esc(s.out_time) + ' (' + esc(s.duration) + ')' : '<span style="color:#b7791f">not logged out</span>'}<br><span class="small">${esc(s.site || '')} · ${esc(s.ref)}</span></div>`).join('') || '<div class="small">No records yet.</div>'}</div><button class="ghost" id="bk">Back</button>`;
    g('bk').onclick = goHome;
  } catch (e) { toast(e.message); }
}

// ---------------- home routing ----------------
function goHome() {
  stopTimers(); $app.className = '';
  if (S.role === 'EMPLOYEE') return loadEmployee();
  if (S.role === 'OWNER') return showOwner();
  S.tab = 'dash'; showTab('dash');
}
function signOut() { try { if (S.token) rawCall('logout_session', { token: S.token }); } catch {} stopTimers(); store.del('pin'); S.token = null; S.role = null; showLogin(); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.role === 'EMPLOYEE' && S.token && !flow) refreshMe(); });

// ---------------- employee home (kept as simple as v2.5) ----------------
async function loadEmployee() {
  try { S.me = await call('me'); } catch (e) { if (e.code === 'NETWORK' || e.code === 'BAD_REPLY') return showOffline(e.message); return; }
  clearInterval(S.poll); S.poll = setInterval(refreshMe, 60000); renderEmployee();
}
async function refreshMe() { try { S.me = await call('me'); if (!flow && S.role === 'EMPLOYEE' && g('hs')) renderEmployee(); } catch {} }
function showOffline(m) { $app.innerHTML = `<div class="card"><div class="banner bad">${esc(m)}</div><button id="rt">Retry</button></div>`; g('rt').onclick = goHome; }
function renderEmployee() {
  const { user: e, company: c, open_session: o, last_session: last } = S.me, l = c.licence; S.user = e;
  setHeader(e.id); $nav.innerHTML = '';
  let action = '', status = '';
  if (o) {
    status = `<div class="banner ok">Checked in at <b>${esc(o.in_time)}</b> — ${esc(o.site || '')}</div><div class="timer" id="tm"></div>`;
    action = `<button class="red big" id="out">LOGOUT</button>`;
  } else if (last && last.out_time) {
    status = `<div class="banner ok">Today: IN ${esc(last.in_time)} → OUT ${esc(last.out_time)} · Working hours ${esc(last.duration || '')}</div>`;
    action = `<button class="green big" id="in">LOGIN AGAIN</button>`;
  } else { status = `<div class="banner warn">Attendance not marked today.</div>`; action = `<button class="green big" id="in">LOGIN (MARK ATTENDANCE)</button>`; }
  $app.innerHTML = `<div class="card"><div style="font-size:20px;font-weight:700">${esc(e.name)}</div><div class="small">${esc(c.name)}</div>
    <div class="row"><span>Employee ID</span><b>${esc(e.id)}</b></div><div class="row"><span>Designation</span><span>${esc(e.designation || '—')}</span></div>
    <div class="row"><span>Department</span><span>${esc(e.department || '—')}</span></div><div class="row"><span>Assigned site</span><span>${esc(e.site || '—')}</span></div>
    <div class="row"><span>Today</span><span>${fmtDate(todayIST())}</span></div></div>
    <div class="banner ${l.state === 'trial' ? 'warn' : 'ok'}">${esc(l.message)}</div>${status}${action}
    <button class="ghost" id="hs">Attendance history</button><button class="ghost" id="lo">Sign out</button>
    <div class="small" style="margin-top:12px;text-align:center">Your photo and GPS location are recorded at login, and GPS location at logout, for attendance purposes only.</div>
    <div class="small" style="margin-top:8px;text-align:center">App v${APP_VERSION} · ${isNative ? 'phone app' : 'browser'}</div>`;
  if (o) { const tick = () => { if (g('tm')) g('tm').textContent = dur(serverNow() - new Date(o.in_ts)); }; tick(); clearInterval(S.timer); S.timer = setInterval(tick, 20000); }
  if (g('in')) g('in').onclick = startCheckIn; if (g('out')) g('out').onclick = doCheckOut;
  g('hs').onclick = showHistory; g('lo').onclick = signOut;
}

// ---------------- admin / manager shell ----------------
const TABS = [['dash', '📊', 'Dashboard'], ['emps', '👥', 'Employees'], ['loc', '📍', 'Location'], ['rep', '📑', 'Reports'], ['co', '🏢', 'Company']];
function showTab(id) {
  S.tab = id; stopTimers(); $app.className = 'pad'; setHeader((S.role === 'ADMIN' ? 'Admin' : 'Manager') + ' · ' + (S.company ? S.company.id : ''));
  $nav.innerHTML = '<nav>' + TABS.map(([k, ic, nm]) => `<button data-t="${k}" class="${k === id ? 'on' : ''}"><i>${ic}</i>${nm}</button>`).join('') + '</nav>';
  $nav.querySelectorAll('button').forEach(b => { b.onclick = () => showTab(b.dataset.t); });
  $app.innerHTML = '<div class="small" style="text-align:center;padding:30px">Loading…</div>';
  ({ dash: renderDash, emps: renderEmps, loc: renderLoc, rep: renderRep, co: renderCo })[id]().catch((e) => { if (e.code !== 'SESSION_EXPIRED') $app.innerHTML = `<div class="banner bad">${esc(e.message)}</div><button id="rt">Retry</button>`; if (g('rt')) g('rt').onclick = () => showTab(id); });
}
async function renderDash() {
  const d = await call('dashboard'), l = d.licence;
  const st = (n, t) => `<div class="stat"><b>${n}</b><span>${t}</span></div>`;
  $app.innerHTML = `<div class="small" style="margin-bottom:8px">${esc(S.company.name)} · ${fmtDate(d.today)}</div>
    ${l.valid ? '' : `<div class="banner bad">${esc(l.message)}</div>`}${l.valid && l.days_left !== null && l.days_left <= 7 ? `<div class="banner warn">${esc(l.message)}</div>` : ''}
    <div class="grid">${st(d.total_employees, 'Total employees')}${st(d.active_employees, 'Active employees')}${st(d.present_today, "Today's present")}${st(d.absent_today, "Today's absent")}
    ${st(d.logged_in_now, 'Currently logged in')}${st(d.completed_checkouts, 'Completed check-outs')}${st(d.missed_checkouts, 'Missed check-outs (earlier days)')}${st(d.month_attendance_days, 'Attendance days this month')}</div>
    <button class="ghost" id="rf">Refresh</button>`;
  g('rf').onclick = () => showTab('dash');
}

// ---------- employees ----------
async function renderEmps() {
  const r = await call('emp_list'), admin = S.role === 'ADMIN'; S.emps = r.employees; S.types = r.types; S.statuses = r.statuses;
  const draw = (q) => {
    const list = S.emps.filter(e => !q || (e.name + ' ' + e.id + ' ' + e.department + ' ' + e.designation).toLowerCase().includes(q.toLowerCase()));
    g('el').innerHTML = list.map(e => `<div class="card" data-id="${esc(e.id)}" style="cursor:pointer"><b>${esc(e.name)}</b><span class="chip ${esc(e.status)}">${esc(e.status)}</span>${e.role === 'Manager' ? '<span class="chip">Manager</span>' : ''}
      <div class="small">${esc(e.id)} · ${esc(e.designation || '—')} · ${esc(e.department || '—')}${e.manager ? ' · Mgr ' + esc(e.manager) : ''}${e.site ? ' · ' + esc(e.site) : ''}</div></div>`).join('') || '<div class="small">No employees yet.</div>';
    if (admin) g('el').querySelectorAll('[data-id]').forEach(c => { c.onclick = () => empForm(S.emps.find(e => e.id === c.dataset.id)); });
  };
  $app.innerHTML = `<div class="card"><b>${admin ? 'Employees & managers' : 'My team'}</b> <span class="small">(${S.emps.length})</span>${admin ? '<button id="ae">+ Add employee</button><button class="ghost" id="am">+ Add manager</button>' : ''}<input id="q" placeholder="Search name, ID, department" style="margin-top:12px"></div><div id="el"></div>`;
  g('q').oninput = (e) => draw(e.target.value); draw('');
  if (admin) { g('ae').onclick = () => empForm(null, 'Employee'); g('am').onclick = () => empForm(null, 'Manager'); }
}
function empForm(e, role) {
  const isNew = !e, mgrs = S.emps.filter(x => x.role === 'Manager'), v = (k) => esc(e ? (e[k] ?? '') : '');
  const m = modal(`<h3 style="margin:0 0 4px">${isNew ? 'Add ' + role.toLowerCase() : esc(e.name) + ' <span class="small">' + esc(e.id) + '</span>'}</h3><div id="mres"></div>
    <label>Name</label><input id="f_name" value="${v('name')}"><label>Mobile number</label><input id="f_mobile" inputmode="tel" value="${v('mobile')}">
    <label>Designation</label><input id="f_designation" value="${v('designation')}"><label>Department</label><input id="f_department" value="${v('department')}">
    <label>Employee type</label><select id="f_type"><option value=""></option>${(S.types || []).map(t => `<option ${e && e.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
    ${isNew && role === 'Manager' ? '' : `<label>Assigned manager</label><select id="f_manager"><option value="">— none —</option>${mgrs.map(x => `<option value="${esc(x.id)}" ${e && e.manager === x.id ? 'selected' : ''}>${esc(x.name)} (${esc(x.id)})</option>`).join('')}</select>`}
    <label>Assigned site</label><input id="f_site" value="${v('site')}"><div class="grid"><div><label>Site latitude</label><input id="f_lat" inputmode="decimal" value="${v('lat')}"></div><div><label>Site longitude</label><input id="f_lng" inputmode="decimal" value="${v('lng')}"></div></div>
    <label>Geofence radius (m)</label><input id="f_radius" inputmode="numeric" value="${e ? esc(e.radius) : '200'}">
    ${isNew ? '<label>PIN (leave empty to generate)</label><input id="f_pin" inputmode="numeric">' : `<label>Account status</label><select id="f_status">${S.statuses.map(s => `<option ${e.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><label>Expiry date</label><input id="f_expiry" type="date" value="${v('expiry')}">`}
    <button id="fs">${isNew ? 'Create' : 'Save changes'}</button>${isNew ? '' : '<button class="ghost" id="fr">Reset PIN</button>'}<button class="ghost" id="fc">Close</button>`);
  const body = () => { const o = {}; ['name', 'mobile', 'designation', 'department', 'type', 'site', 'lat', 'lng', 'radius'].forEach(k => { o[k] = m.querySelector('#f_' + k).value.trim(); }); if (m.querySelector('#f_manager')) o.manager = m.querySelector('#f_manager').value; if (!isNew) { o.status = m.querySelector('#f_status').value; o.expiry = m.querySelector('#f_expiry').value; } else { o.pin = m.querySelector('#f_pin').value.trim(); o.role = role; } return o; };
  const show = (html, cls) => { m.querySelector('#mres').innerHTML = `<div class="banner ${cls}" style="margin-top:10px">${html}</div>`; };
  m.querySelector('#fc').onclick = () => { m.close(); showTab('emps'); };
  m.querySelector('#fs').onclick = (ev) => busy(ev.target, 'Saving…', async () => {
    try {
      if (isNew) { const r = await call('emp_add', body()); show(`Created <b>${esc(r.employee.name)}</b><br>Employee ID: <b>${esc(r.employee.id)}</b><br>PIN: <b>${esc(r.pin)}</b><br><span class="small">Company ID: ${esc(S.company.id)} — share these 3 details with the employee. The PIN is shown only now.</span>`, 'ok'); ev.target.classList.add('hidden'); }
      else { await call('emp_update', { id: e.id, ...body() }); m.close(); showTab('emps'); }
    } catch (er) { show(esc(er.message), 'bad'); }
  });
  if (!isNew) m.querySelector('#fr').onclick = (ev) => { if (!confirm('Reset PIN for ' + e.name + '?')) return; busy(ev.target, 'Resetting…', async () => { try { const r = await call('emp_reset_pin', { id: e.id }); show(`New PIN for <b>${esc(e.id)}</b>: <b>${esc(r.pin)}</b><br><span class="small">Shown only now.</span>`, 'ok'); } catch (er) { show(esc(er.message), 'bad'); } }); };
}

// ---------- location & photos ----------
async function renderLoc() {
  if (!S.emps) { const r = await call('emp_list'); S.emps = r.employees; S.types = r.types; S.statuses = r.statuses; }
  const uniq = (k) => [...new Set(S.emps.map(e => e[k]).filter(Boolean))].sort(), mgrs = S.emps.filter(e => e.role === 'Manager'), t = todayIST();
  const opt = (arr) => '<option value="">All</option>' + arr.map(x => `<option>${esc(x)}</option>`).join('');
  $app.innerHTML = `<div class="card"><b>Location & photos</b><div class="grid"><div><label>From</label><input id="l_from" type="date" value="${t}"></div><div><label>To</label><input id="l_to" type="date" value="${t}"></div></div>
    <label>Employee</label><select id="l_emp"><option value="">All</option>${S.emps.filter(e => e.role !== 'Manager').map(e => `<option value="${esc(e.id)}">${esc(e.name)} (${esc(e.id)})</option>`).join('')}</select>
    <div class="grid"><div><label>Department</label><select id="l_dept">${opt(uniq('department'))}</select></div><div><label>Designation</label><select id="l_des">${opt(uniq('designation'))}</select></div>
    <div><label>Manager</label><select id="l_mgr"><option value="">All</option>${mgrs.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></div><div><label>Site</label><select id="l_site">${opt(uniq('site'))}</select></div></div>
    <button id="l_go">Show</button></div><div id="lres"></div>`;
  const run = () => busy(g('l_go'), 'Loading…', async () => {
    try {
      const r = await call('att_list', { from: val('l_from'), to: val('l_to'), emp: val('l_emp'), dept: val('l_dept'), designation: val('l_des'), manager: val('l_mgr'), site: val('l_site') });
      S.locRows = r.rows;
      g('lres').innerHTML = `<div class="small" style="margin:6px 2px">${r.count} record(s)${r.count >= 500 ? ' (latest 500)' : ''}</div>` + r.rows.map((x, i) => `<div class="card"><b>${esc(x.name)}</b> <span class="small">${esc(x.id)} · ${fmtDate(x.date)}</span>
        <div class="row"><span>Login</span><span>${esc(x.in_time)} · ±${Math.round(x.in_acc || 0)} m</span></div>
        <div class="row"><span>Login location</span><a href="${esc(x.in_map)}" target="_blank" rel="noopener">Open map</a></div>
        <div class="row"><span>Logout</span><span>${x.out_time ? esc(x.out_time) + ' · ±' + Math.round(x.out_acc || 0) + ' m' : '<b style="color:#b7791f">NOT LOGGED OUT</b>'}</span></div>
        ${x.out_map ? `<div class="row"><span>Logout location</span><a href="${esc(x.out_map)}" target="_blank" rel="noopener">Open map</a></div>` : ''}
        <div class="row"><span>Working hours</span><span>${x.hours === null ? '—' : x.hours + ' h'}</span></div>
        <div class="row"><span>Site</span><span>${esc(x.site || '—')}${x.in_dist !== null && x.in_dist !== '' ? ' · ' + x.in_dist + ' m' : ''} · ${esc(x.in_on || '')}</span></div>
        ${x.photo_id ? `<button class="sm ghost" data-p="${i}">View login photo</button>` : ''}</div>`).join('');
      g('lres').querySelectorAll('[data-p]').forEach(b => { b.onclick = () => showPhoto(S.locRows[+b.dataset.p], b); });
    } catch (e) { g('lres').innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
  });
  g('l_go').onclick = run; run();
}
async function showPhoto(row, btn) {
  await busy(btn, 'Loading…', async () => {
    try { const r = await call('photo', { photo_id: row.photo_id }); const m = modal(`<b>${esc(row.name)}</b> <span class="small">${fmtDate(row.date)} ${esc(row.in_time)}</span><img class="thumb" src="${r.image}"><button id="pc">Close</button>`); m.querySelector('#pc').onclick = () => m.close(); }
    catch (e) { toast(e.message); }
  });
}

// ---------- reports / Excel ----------
async function saveWorkbook(wb, name) {
  const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
  const FS = plugin('Filesystem'), SH = plugin('Share');
  if (FS && SH) { const f = await FS.writeFile({ path: name, data: b64, directory: 'CACHE' }); await SH.share({ title: name, url: f.uri, dialogTitle: 'Save or share the Excel report' }); return 'shared'; }
  const a = document.createElement('a'); a.href = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + b64; a.download = name; document.body.appendChild(a); a.click(); a.remove(); return 'downloaded';
}
async function makeReport(kind, filter, label, btn) {
  await busy(btn, 'Preparing…', async () => {
    try {
      const rep = await call('report_month', Object.assign({ month: val('m') }, filter || {}));
      rep.generated = new Date(Date.now() + S.offset).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
      if (!rep.employees.length) return toast('No employees match this selection.');
      const wb = FA_Excel.build(XLSX, rep, kind), safe = String(S.company.name).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 24);
      await saveWorkbook(wb, `${label}_${rep.month}_${safe}.xlsx`);
    } catch (e) { toast(e.message); }
  });
}
async function renderRep() {
  if (!S.emps) { const r = await call('emp_list'); S.emps = r.employees; S.types = r.types; S.statuses = r.statuses; }
  const depts = [...new Set(S.emps.map(e => e.department).filter(Boolean))].sort(), now = todayIST().slice(0, 7);
  $app.innerHTML = `<div class="card"><b>Monthly reports (Excel)</b><div class="small">Sundays are yellow. P = present, L = leave, WO = weekly off, MC = logout missing.</div>
    <label>Month</label><input id="m" type="month" value="${now}">
    <button data-k="pa" data-l="PA">Download Monthly P/L Excel</button><button data-k="hours" data-l="Hours">Download Monthly Hours Excel</button>
    <button data-k="location" data-l="Location">Download Monthly Location Excel</button><button class="green" data-k="all" data-l="Complete_Report">Download Complete Monthly Report</button></div>
    <div class="card"><b>Employee-wise report</b><select id="r_emp" style="margin-top:8px">${S.emps.filter(e => e.role !== 'Manager').map(e => `<option value="${esc(e.id)}">${esc(e.name)} (${esc(e.id)})</option>`).join('')}</select><button class="ghost" id="r_e">Download employee report</button></div>
    <div class="card"><b>Department-wise report</b><select id="r_dep" style="margin-top:8px">${depts.map(d => `<option>${esc(d)}</option>`).join('') || '<option value="">(no departments set)</option>'}</select><button class="ghost" id="r_d">Download department report</button></div>`;
  $app.querySelectorAll('button[data-k]').forEach(b => { b.onclick = () => makeReport(b.dataset.k, {}, b.dataset.l, b); });
  g('r_e').onclick = (ev) => makeReport('all', { emp: val('r_emp') }, 'Employee_' + val('r_emp'), ev.target);
  g('r_d').onclick = (ev) => { if (!val('r_dep')) return toast('Set a department on employees first.'); makeReport('all', { dept: val('r_dep') }, 'Department_' + val('r_dep').replace(/\W+/g, '_'), ev.target); };
}

// ---------- company / subscription ----------
async function renderCo() {
  const c = await call('company_info'), l = c.licence, admin = S.role === 'ADMIN';
  $app.innerHTML = `<div class="card"><b>${esc(c.name)}</b><div class="row"><span>Company ID</span><b>${esc(c.id)}</b></div><div class="row"><span>Administrator</span><span>${esc(c.admin_name)}</span></div>
    <div class="row"><span>Mobile</span><span>${esc(c.mobile)}</span></div><div class="row"><span>Email</span><span>${esc(c.email)}</span></div><div class="row"><span>Business</span><span>${esc(c.business_type)}</span></div><div class="row"><span>Address</span><span>${esc(c.address)}</span></div>
    ${admin ? `<div class="row"><span>Data stored in Google account</span><span>${esc(c.google_account)}</span></div>` : ''}</div>
  ${admin ? `<div class="card"><b>Subscription</b><div class="row"><span>Plan</span><span>${esc(c.plan)}</span></div><div class="row"><span>Status</span><span class="chip ${esc(l.state[0].toUpperCase() + l.state.slice(1))}">${esc(l.state)}</span></div>
    <div class="row"><span>Expiry date</span><span>${esc(c.expiry || '—')}</span></div><div class="row"><span>Days left</span><span>${l.days_left ?? '—'}</span></div><div class="row"><span>User limit</span><span>${c.employee_limit}</span></div>
    <div class="banner ${l.valid ? 'ok' : 'bad'}" style="margin-top:10px">${esc(l.message)}</div><div class="small">To renew or upgrade, contact the app provider with your Company ID.</div></div>
    <button class="ghost" id="rc">Reconnect Google account</button>` : ''}
  <button class="ghost" id="so">Sign out</button><div class="small" style="margin-top:12px;text-align:center">App v${APP_VERSION} · ${isNative ? 'phone app' : 'browser'}</div>`;
  g('so').onclick = signOut;
  if (admin) g('rc').onclick = (ev) => busy(ev.target, 'Please wait…', async () => { try { const r = await call('reconnect_url'); openUrl(r.auth_url); toast('Sign in with the SAME Google account used at registration, then come back to the app.'); } catch (e) { toast(e.message); } });
}

// ---------------- owner console ----------------
function showOwnerLogin(msg) {
  stopTimers(); $nav.innerHTML = ''; setHeader('');
  $app.innerHTML = `<div class="card"><h2 style="margin:0 0 4px">Owner sign-in</h2><div class="small">For the app owner only</div>${msg ? `<div class="banner bad" style="margin-top:12px">${esc(msg)}</div>` : ''}
    <label>Owner password</label><input id="op" type="password"><button id="og">Sign in</button><button class="ghost" id="ob">Back</button></div>`;
  g('ob').onclick = () => showLogin();
  g('og').onclick = (ev) => busy(ev.target, 'Signing in…', async () => { try { const pw = val('op'); const r = await rawCall('owner_login', { password: pw }); applyLogin(r); store.set('co', 'OWNER'); store.set('uid', 'OWNER'); store.set('pin', pw); showOwner(); } catch (e) { showOwnerLogin(e.message); } });
}
async function showOwner() {
  $app.className = ''; setHeader('Owner'); $nav.innerHTML = '';
  try {
    const { companies } = await call('owner_list'); S.cos = companies;
    $app.innerHTML = `<div class="card"><b>Companies</b> <span class="small">(${companies.length})</span><button class="ghost" id="rf">Refresh</button></div>` + companies.map(c => `<div class="card" data-c="${esc(c.id)}" style="cursor:pointer"><b>${esc(c.name)}</b><span class="chip ${esc(c.status)}">${esc(c.status)}</span>
      <div class="small">${esc(c.id)} · ${esc(c.plan)} · expires ${esc(c.expiry || '—')} (${c.days_left ?? '—'} d) · limit ${c.employee_limit}</div><div class="small">${esc(c.admin_name)} · ${esc(c.mobile)} · ${esc(c.google_account)}</div></div>`).join('') + `<button class="ghost" id="ols">Sign out</button>`;
    g('rf').onclick = showOwner; g('ols').onclick = signOut; $app.querySelectorAll('[data-c]').forEach(d => { d.onclick = () => ownerForm(S.cos.find(c => c.id === d.dataset.c)); });
  } catch (e) { $app.innerHTML = `<div class="banner bad">${esc(e.message)}</div><button class="ghost" id="ols">Sign out</button>`; g('ols').onclick = signOut; }
}
function ownerForm(c) {
  const m = modal(`<h3 style="margin:0">${esc(c.name)} <span class="small">${esc(c.id)}</span></h3><div id="mres"></div><div id="od" class="small" style="margin-top:8px">Loading usage…</div>
    <label>Status</label><select id="o_st">${['Trial', 'Active', 'Suspended', 'Expired'].map(s => `<option ${c.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <label>Plan</label><input id="o_pl" value="${esc(c.plan)}" placeholder="Trial / Monthly / Annual / Per-employee"><label>Expiry date</label><input id="o_ex" type="date" value="${esc(c.expiry)}">
    <label>Employee limit</label><input id="o_lm" inputmode="numeric" value="${esc(c.employee_limit)}"><label>Extend by (days)</label><input id="o_xd" inputmode="numeric" placeholder="e.g. 30 or 365">
    <button id="os">Save</button><button class="ghost" id="oc">Close</button>`);
  call('owner_detail', { company_id: c.id }).then(d => { m.querySelector('#od').textContent = `Users: ${d.users} · Last attendance: ${d.last_attendance_date || '—'}${d.google_error ? ' · Google: ' + d.google_error : ''}`; }).catch(() => {});
  m.querySelector('#oc').onclick = () => m.close();
  m.querySelector('#os').onclick = (ev) => busy(ev.target, 'Saving…', async () => {
    const p = { company_id: c.id, status: m.querySelector('#o_st').value, plan: m.querySelector('#o_pl').value.trim(), limit: m.querySelector('#o_lm').value.trim() };
    const ex = m.querySelector('#o_ex').value, xd = m.querySelector('#o_xd').value.trim(); if (xd) p.extend_days = xd; else if (ex) p.expiry = ex;
    try { await call('owner_update', p); m.close(); showOwner(); } catch (e) { m.querySelector('#mres').innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; }
  });
}

// ---------------- start ----------------
(async function start() {
  const co = store.get('co'), id = store.get('uid'), pin = store.get('pin');
  if (co && id && pin) { try { const r = await relogin(); applyLogin(r); goHome(); } catch (e) { if (e.code === 'NETWORK' || e.code === 'BAD_REPLY') return showOffline(e.message); showLogin(e.message); } }
  else showLogin();
})();

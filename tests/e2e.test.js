'use strict';
// END-TO-END (simulated Google + simulated phone): the REAL www/index.html + app.js run in jsdom, talk to the REAL Code.gs through the fake Google.
// Flow: register company (Google sign-in) -> admin adds employee -> employee logs in, photo + GPS check-in -> logout -> admin sees location/photo,
// downloads Excel -> owner suspends company -> employee blocked. Camera/GPS/Browser/Filesystem/Share are fakes of the Capacitor plugins.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const XLSX = require('xlsx-js-style');
const { load } = require('./mock-google');

const www = (f) => fs.readFileSync(path.join(__dirname, '../www', f), 'utf8');
const PIXEL = Buffer.from('fakejpegbytes').toString('base64');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 4000) { const t0 = Date.now(); for (;;) { try { const v = fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what + '\nSCREEN: ' + (globalThis.__dom ? globalThis.__dom.window.document.body.textContent.replace(/\s+/g, ' ').slice(0, 400) : '')); await sleep(15); } }

function phone(E, opts = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><header><b id="hdr"></b><span id="who"></span></header><main id="app"></main><div id="nav"></div></body></html>', { url: 'https://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  globalThis.__dom = dom; const w = dom.window, d = w.document, calls = { opened: [], files: [], shared: [], alerts: [] };
  w.APP_CONFIG = { SERVER_URL: 'https://script.google.com/macros/s/TEST/exec' };
  w.fetch = async (url, o) => ({ json: async () => E.api(JSON.parse(o.body)) });
  w.alert = (m) => calls.alerts.push(m); w.confirm = () => true; w.XLSX = XLSX;
  const plugins = {
    Camera: { checkPermissions: async () => ({ camera: 'granted' }), requestPermissions: async () => ({ camera: 'granted' }), getPhoto: async (o) => { calls.photoOpts = o; return { base64String: PIXEL, format: 'jpeg' }; } },
    Geolocation: { checkPermissions: async () => ({ location: 'granted' }), requestPermissions: async () => ({ location: 'granted' }), clearWatch: async () => {} },
    Browser: { open: async (o) => { calls.opened.push(o.url); } },
    Filesystem: { writeFile: async (o) => { calls.files.push(o); return { uri: 'file:///cache/' + o.path }; } },
    Share: { share: async (o) => { calls.shared.push(o); return {}; } },
  };
  w.Capacitor = { isNativePlatform: () => true,
    nativePromise: (p, m, o) => { if (!plugins[p] || !plugins[p][m]) return Promise.reject(new Error(p + '.' + m + ' not implemented')); return plugins[p][m](o); },
    nativeCallback: (p, m, o, cb) => { setTimeout(() => cb({ timestamp: Date.now(), coords: { latitude: 18.5204, longitude: 73.8567, accuracy: opts.acc || 15 } }), 10); return 'w1'; } };
  const run = (code) => { const s = d.createElement('script'); s.textContent = code; d.body.appendChild(s); s.remove(); };
  run(www('excel.js')); run(www('app.js') + '\n;window.stamp = async (raw) => raw;');   // canvas is not available in jsdom: keep the raw photo
  const $ = (s) => d.querySelector(s), text = () => d.body.textContent.replace(/\s+/g, ' ');
  const type = (sel, v) => { const el = $(sel); if (!el) throw new Error('missing ' + sel); el.value = v; };
  const click = (sel) => { const el = $(sel); if (!el) throw new Error('missing ' + sel); el.click(); };
  return { w, d, $, text, type, click, calls, has: (t) => text().includes(t) };
}
async function signIn(P, co, id, pin) { await until(() => P.$('#go'), 'login form'); P.type('#co', co); P.type('#u', id); P.type('#p', pin); P.click('#go'); }

test('END-TO-END: register -> add employee -> check-in (photo+GPS) -> logout -> admin sees location/photo + Excel -> owner suspends -> employee blocked', async () => {
  const E = load(); E.x.setup(); const P = phone(E);
  // 1. company registration through Google sign-in
  await until(() => P.$('#reg'), 'login screen'); P.click('#reg');
  await until(() => P.$('#r_go'), 'register form');
  P.type('#r_co', 'Sun Solar Pvt Ltd'); P.type('#r_nm', 'Asha Admin'); P.type('#r_mb', '9876543210'); P.type('#r_em', 'asha@sunsolar.in'); P.type('#r_pw', 'Secret123'); P.type('#r_n', '12'); P.type('#r_ad', 'Pune');
  P.click('#r_go'); await until(() => P.calls.opened.length === 1, 'Google sign-in opened');
  const authUrl = new URL(P.calls.opened[0]); assert.equal(authUrl.hostname, 'accounts.google.com'); assert.ok(authUrl.searchParams.get('scope').includes('drive.file'));
  assert.ok(!authUrl.searchParams.get('scope').includes('spreadsheets'), 'only drive.file + email scopes are requested');
  P.d.dispatchEvent(new P.w.Event('visibilitychange'));                               // before Google finishes: still waiting
  await sleep(50); assert.ok(P.has('Waiting for Google sign-in'));
  const html = E.oauth({ code: 'CODE:asha@sunsolar.in', state: authUrl.searchParams.get('state') });   // the customer taps "Allow" in the browser
  const cid = /FA[A-Z0-9]{5}/.exec(html)[0];
  P.d.dispatchEvent(new P.w.Event('visibilitychange')); await until(() => P.has('Company registered'), 'registration done'); assert.ok(P.has(cid));
  P.click('#ok');
  // 2. admin signs in, adds an employee inside the app
  await signIn(P, cid, 'ADMIN', 'Secret123'); await until(() => P.has("Today's present"), 'admin dashboard');
  assert.ok(P.has('Total employees')); P.click('nav [data-t="emps"]'); await until(() => P.$('#ae'), 'employee tab'); P.click('#ae');
  await until(() => P.$('#f_name'), 'employee form'); P.type('#f_name', 'Ravi Kumar'); P.type('#f_mobile', '9000000001'); P.type('#f_designation', 'Solar Technician'); P.type('#f_department', 'Installation');
  P.d.querySelector('#f_type').value = 'Technician'; P.click('#fs');
  await until(() => /PIN: \d{6}/.test(P.d.querySelector('#mres') ? P.d.querySelector('#mres').textContent : ''), 'employee created');
  const pin = /PIN: (\d{6})/.exec(P.d.querySelector('#mres').textContent)[1]; assert.ok(P.d.querySelector('#mres').textContent.includes('E001'));
  P.click('#fc'); await sleep(50); P.click('nav [data-t="co"]'); await until(() => P.$('#so'), 'company tab'); assert.ok(P.has('Free trial')); assert.ok(P.has('asha@sunsolar.in')); P.click('#so');
  // 3. employee: login screen -> photo + GPS -> check-in
  await signIn(P, cid, 'E001', pin); await until(() => P.$('#in'), 'employee home'); assert.ok(P.has('Ravi Kumar')); assert.ok(P.has('Installation')); assert.ok(P.has('Solar Technician'));
  P.click('#in'); await until(() => P.$('#sub'), 'photo preview');
  assert.equal(P.calls.photoOpts.source, 'CAMERA'); assert.equal(P.calls.photoOpts.direction, 'FRONT'); assert.equal(P.calls.photoOpts.width, 800);   // live front camera only
  await until(() => P.has('Location ready'), 'GPS fix'); P.click('#sub'); await until(() => P.has('Attendance recorded'), 'check-in saved');
  const H = E.x.ATT_H, coRow = E.registry.ss.getSheetByName('Companies').g.find(r => r[0] === cid), ss = E.sheetsById[coRow[9]], row = ss.tabs.Attendance.g[1];
  assert.equal(ss.owner, 'asha@sunsolar.in'); assert.equal(row[H.indexOf('Employee ID')], 'E001'); assert.equal(row[H.indexOf('Company ID')], cid); assert.equal(row[H.indexOf('IN Lat')], 18.5204);
  assert.equal(Object.values(E.filesById).filter(f => !f.folder).length, 1);
  P.click('#ok'); await until(() => P.$('#out'), 'logout button'); P.click('#out'); await until(() => P.has('Logged out'), 'logout saved');
  assert.equal(ss.tabs.Attendance.g[1][H.indexOf('Status')], 'CLOSED'); assert.ok(ss.tabs.Attendance.g[1][H.indexOf('OUT Lat')]);
  P.click('#ok'); await until(() => P.$('#hs'), 'home'); P.click('#hs'); await until(() => P.has('Attendance history') && P.has('ATT-'), 'history'); P.click('#bk'); await until(() => P.$('#lo'), 'home'); P.click('#lo');
  // 4. admin: location & photos, photo is shown through the authorised call, Excel download
  await signIn(P, cid, 'ADMIN', 'Secret123'); await until(() => P.$('nav [data-t="loc"]'), 'admin home'); P.click('nav [data-t="loc"]');
  await until(() => P.has('Ravi Kumar') && P.$('[data-p]'), 'location list'); assert.ok(P.has('Open map')); P.click('[data-p]');
  await until(() => P.$('.modal img'), 'photo modal'); assert.ok(P.$('.modal img').src.startsWith('data:image/jpeg;base64,')); P.click('#pc');
  P.click('nav [data-t="rep"]'); await until(() => P.$('button[data-k="all"]'), 'reports tab'); P.click('button[data-k="all"]');
  await until(() => P.calls.files.length === 1 && P.calls.shared.length === 1, 'excel saved + shared');
  const wb = XLSX.read(Buffer.from(P.calls.files[0].data, 'base64'), { type: 'buffer', cellStyles: true }); const ym = E.x.ymd_(new Date()).slice(0, 7);
  assert.deepEqual(wb.SheetNames, ['PA_' + ym, 'Hours_' + ym, 'Location_' + ym]); assert.match(P.calls.files[0].path, /^Complete_Report_\d{4}-\d{2}_Sun_Solar/);
  P.click('nav [data-t="co"]'); await until(() => P.$('#so'), 'company tab'); P.click('#so');
  // 5. owner suspends the company: employee can no longer sign in, admin still can
  await until(() => P.$('#own'), 'login'); P.click('#own'); await until(() => P.$('#op'), 'owner login'); P.type('#op', 'owner-pass-1'); P.click('#og');
  await until(() => P.has('Sun Solar Pvt Ltd') && P.has('Trial'), 'owner list'); P.d.querySelector('[data-c="' + cid + '"]').click();
  await until(() => P.$('#o_st'), 'owner form'); P.d.querySelector('#o_st').value = 'Suspended'; P.click('#os'); await until(() => !P.$('.modal') && (P.d.querySelector('[data-c="' + cid + '"] .chip') || {}).textContent === 'Suspended', 'suspended shown'); P.click('#ols');
  delete E.cache['co_' + cid]; await signIn(P, cid, 'E001', pin);
  await until(() => P.has('subscription is suspended'), 'employee blocked'); assert.equal(ss.tabs.Attendance.g.length, 2);
});

test('admin and employee screens differ; manager sees team only; wrong PIN shows a clear message; app works with no stored login', async () => {
  const E = load(); E.x.setup(); const P = phone(E);
  const r = E.api({ action: 'register_start', company_name: 'Beta Works', admin_name: 'B', mobile: '9876543210', email: 'b@beta.com', admin_pin: 'Secret123' });
  E.oauth({ code: 'CODE:b@beta.com', state: new URL(r.auth_url).searchParams.get('state') }); const cid = r.company_id;
  const tok = E.api({ action: 'login', company_id: cid, id: 'ADMIN', pin: 'Secret123' }).token;
  const m = E.api({ action: 'emp_add', token: tok, name: 'Meera Mgr', role: 'Manager' }), e = E.api({ action: 'emp_add', token: tok, name: 'Eka Emp', manager: 'M001' });
  await signIn(P, cid, 'E001', '000000'); await until(() => P.has('Incorrect Company ID'), 'wrong pin message');
  P.type('#p', e.pin); P.click('#go'); await until(() => P.$('#in'), 'employee home'); assert.ok(!P.$('nav button')); P.click('#lo');
  await signIn(P, cid, 'M001', m.pin); await until(() => P.has("Today's present"), 'manager dashboard'); P.click('nav [data-t="emps"]'); await until(() => P.has('My team') && P.has('Eka Emp'), 'team');
  assert.ok(!P.$('#ae')); assert.ok(!P.has('Meera Mgr')); P.click('nav [data-t="co"]'); await until(() => P.$('#so'), 'co'); assert.ok(!P.has('Subscription'));
});

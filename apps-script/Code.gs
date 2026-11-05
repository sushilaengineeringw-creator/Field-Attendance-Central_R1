/**
 * Field Attendance App - CENTRAL backend (Google Apps Script, owner account, deployed ONCE).
 *
 * One APK, many companies. Each company's attendance sheet and photos live in THAT COMPANY ADMIN'S OWN Google
 * account (created automatically after the admin signs in with Google). This script only keeps:
 *   - a private "registry" (company list, licence, hashed admin PIN) in the owner's account, and
 *   - each admin's Google refresh token (encrypted) in Script Properties, used to write that company's rows/photos.
 * It never reads any other file in a company's Drive (scope = drive.file: only files this app created).
 *
 * Attendance engine = VATS v2.5 logic: idempotent check-in/out, duplicate pre-check before photo upload,
 * photo upload outside the lock, recent-rows reads for daily actions, best-effort GPS recorded with accuracy.
 */
var TZ = 'Asia/Kolkata';
var PRODUCT = 'Field Attendance App';
var LOW_ACCURACY_WARN_M = 100, MAX_PHOTO_B64 = 4000000, MAX_FAILS = 5, RECENT_ROWS = 600, SESSION_TTL = 21600, TRIAL_DAYS_DEFAULT = 14;
var API_S = 'https://sheets.googleapis.com/v4/spreadsheets', API_D = 'https://www.googleapis.com/drive/v3', API_U = 'https://www.googleapis.com/upload/drive/v3';
var OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';

var CO_H = ['Company ID', 'Company Name', 'Admin Name', 'Mobile', 'Email', 'Business Type', 'Employees (expected)', 'Address', 'Google Account', 'Spreadsheet ID',
  'Photos Folder ID', 'Reports Folder ID', 'Status', 'Plan', 'Expiry Date', 'Employee Limit', 'Created', 'Admin Salt', 'Admin Hash', 'Notes', 'Root Folder ID'];
var EMP_H = ['Employee ID', 'Name', 'PIN Hash', 'PIN Salt', 'Role', 'Status', 'Expiry Date', 'Mobile', 'Designation', 'Department', 'Employee Type',
  'Manager ID', 'Site', 'Site Lat', 'Site Long', 'Radius (m)', 'Created', 'Updated', 'Notes'];
var ATT_H = ['Ref', 'Date', 'Employee ID', 'Name', 'Site', 'IN Time', 'IN Lat', 'IN Long', 'IN Accuracy (m)', 'IN Map', 'Photo', 'IN Distance from site (m)', 'IN On site?',
  'OUT Time', 'OUT Lat', 'OUT Long', 'OUT Accuracy (m)', 'OUT Map', 'OUT On site?', 'Duration', 'Status', 'IN Server Time', 'OUT Server Time', 'IN Key', 'OUT Key', 'Company ID'];
var EMP_TYPES = ['Field Sales', 'Service Engineer', 'Site Engineer', 'Technician', 'Other'];
var EMP_STATUS = ['Active', 'Trial', 'Suspended', 'Revoked', 'Inactive'];

// ---------------- small helpers ----------------
function fail_(code, msg, extra) { var e = new Error(msg); e.code = code; e.extra = extra || null; return e; }
function P_() { return PropertiesService.getScriptProperties(); }
function C_() { return CacheService.getScriptCache(); }
function ea_(n) { return ATT_H.indexOf(n); }
function ee_(n) { return EMP_H.indexOf(n); }
function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
function ymd_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function hm_(d) { return Utilities.formatDate(d, TZ, 'HH:mm'); }
function mapLink_(lat, lng) { return 'https://www.google.com/maps?q=' + lat + ',' + lng; }
function dayNum_(s) { var p = String(s).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000; }
function addDays_(ymd, n) { var d = new Date(dayNum_(ymd) * 86400000 + n * 86400000); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
function round2_(x) { return Math.round(x * 100) / 100; }
function str_(v) { return v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
function hex_(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) { var b = (bytes[i] + 256) % 256; s += (b < 16 ? '0' : '') + b.toString(16); } return s; }
function sha_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)); }
function rnd_(n, alphabet) { var s = ''; for (var i = 0; i < n; i++) s += alphabet.charAt(Math.floor(Math.random() * alphabet.length)); return s; }
function safeEq_(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; var d = 0; for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function pad_(rows, w) { return rows.map(function (r) { r = r.slice(); while (r.length < w) r.push(''); return r; }); }
function cfg_(k) { var v = P_().getProperty(k); if (!v) throw fail_('SETUP', 'Server is not set up yet (' + k + ' missing). Owner must follow GOOGLE_CLOUD_SETUP.md.'); return v; }

// Refresh tokens are stored encrypted (HMAC keystream XOR) with a key that lives only in Script Properties.
function ks_(n) { var key = cfg_('ENC_KEY'), out = [], i = 0; while (out.length < n) { var blk = Utilities.computeHmacSha256Signature('blk' + (i++), key); for (var j = 0; j < blk.length; j++) out.push(blk[j]); } return out.slice(0, n); }
function xor_(bytes) { var k = ks_(bytes.length), o = []; for (var i = 0; i < bytes.length; i++) o.push(((bytes[i] ^ k[i]) << 24) >> 24); return o; }
function enc_(s) { return Utilities.base64Encode(xor_(Utilities.base64Decode(Utilities.base64Encode(s)))); }
function dec_(b64) { if (!b64) return ''; return Utilities.newBlob(xor_(Utilities.base64Decode(b64))).getDataAsString(); }

// ---------------- web app entry points ----------------
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.code || p.error) return oauthCallback_(p);
  return ContentService.createTextOutput(PRODUCT + ' backend is running.');
}
function doPost(e) {
  var out;
  try { var req = JSON.parse(e.postData.contents); out = route_(req); out.ok = true; }
  catch (err) {
    out = { ok: false, error: err.code || 'SERVER_ERROR', message: err.code ? err.message : 'Something went wrong. Please retry.' };
    if (err.extra) out.licence = err.extra;
    if (!err.code) console.error(err && err.stack || err);
  }
  out.server_time = new Date().toISOString();
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function route_(req) {
  switch (req.action) {
    case 'register_start': return registerStart_(req);
    case 'register_status': return registerStatus_(req);
    case 'login': return login_(req);
    case 'owner_login': return ownerLogin_(req);
    case 'me': return me_(req);
    case 'logout_session': return logoutSession_(req);
    case 'checkin': return checkin_(req);
    case 'checkout': return checkout_(req);
    case 'history': return history_(req);
    case 'dashboard': return dashboard_(req);
    case 'att_list': return attList_(req);
    case 'photo': return photo_(req);
    case 'report_month': return reportMonth_(req);
    case 'emp_list': return empList_(req);
    case 'emp_add': return empAdd_(req);
    case 'emp_update': return empUpdate_(req);
    case 'emp_reset_pin': return empResetPin_(req);
    case 'company_info': return companyInfo_(req);
    case 'reconnect_url': return reconnectUrl_(req);
    case 'owner_list': return ownerList_(req);
    case 'owner_update': return ownerUpdate_(req);
    case 'owner_detail': return ownerDetail_(req);
    default: throw fail_('BAD_REQUEST', 'Unknown request.');
  }
}

// ---------------- Google REST (as the company admin) ----------------
function http_(method, url, o) {
  o = o || {}; var opt = { method: method, muteHttpExceptions: true, headers: o.headers || {} };
  if (o.json !== undefined) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(o.json); }
  if (o.form) opt.payload = o.form;
  if (o.body !== undefined) { opt.payload = o.body; if (o.ctype) opt.contentType = o.ctype; }
  var r = UrlFetchApp.fetch(url, opt), txt = r.getContentText(), j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { code: r.getResponseCode(), json: j, text: txt, resp: r };
}
function tokenFor_(co) {
  if (co._at) return co._at;
  var cache = C_(), k = 'at_' + co.id, t = cache.get(k); if (t) return t;
  var rt = dec_(P_().getProperty('RT_' + co.id));
  if (!rt) throw fail_('GOOGLE_RECONNECT', 'The company\'s Google account is not connected. The administrator must reconnect it in the app.');
  var r = http_('post', 'https://oauth2.googleapis.com/token', { form: { client_id: cfg_('CLIENT_ID'), client_secret: cfg_('CLIENT_SECRET'), refresh_token: rt, grant_type: 'refresh_token' } });
  if (r.code !== 200 || !r.json || !r.json.access_token) throw fail_('GOOGLE_RECONNECT', 'Google access for this company has expired or was removed. The administrator must reconnect it in the app.');
  cache.put(k, r.json.access_token, Math.max(60, (r.json.expires_in || 3600) - 300));
  return r.json.access_token;
}
function g_(co, method, url, o) {
  o = o || {};
  for (var attempt = 0; attempt < 2; attempt++) {
    o.headers = { Authorization: 'Bearer ' + tokenFor_(co) };
    var r = http_(method, url, o);
    if (r.code === 401 && !co._at && attempt === 0) { C_().remove('at_' + co.id); continue; }
    if (r.code >= 400) { var m = r.json && r.json.error && (r.json.error.message || r.json.error) || ('HTTP ' + r.code); throw fail_('GOOGLE_ERROR', 'Google reported a problem: ' + m); }
    return r;
  }
}
function rd_(co, range) { var r = g_(co, 'get', API_S + '/' + co.sheetId + '/values/' + encodeURIComponent(range) + '?valueRenderOption=UNFORMATTED_VALUE'); return (r.json && r.json.values) || []; }
function wr_(co, range, values) { g_(co, 'put', API_S + '/' + co.sheetId + '/values/' + encodeURIComponent(range) + '?valueInputOption=RAW', { json: { values: values } }); }
function ap_(co, range, values) {
  var r = g_(co, 'post', API_S + '/' + co.sheetId + '/values/' + encodeURIComponent(range) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { json: { values: values } });
  var m = /!?[A-Z]+(\d+):/.exec((r.json && r.json.updates && r.json.updates.updatedRange) || ''); return m ? parseInt(m[1], 10) : 0;
}
function lastRow_(co, tab) { var v = rd_(co, tab + '!A:A'); return v.length; }

// ---------------- registry (owner's private spreadsheet) ----------------
function reg_() { return SpreadsheetApp.openById(cfg_('REGISTRY_ID')); }
function coFromRow_(r, rowNum) {
  return { rowNum: rowNum, id: str_(r[0]), name: str_(r[1]), adminName: str_(r[2]), mobile: str_(r[3]), email: str_(r[4]), btype: str_(r[5]), expected: r[6], address: str_(r[7]),
    google: str_(r[8]), sheetId: str_(r[9]), photosId: str_(r[10]), reportsId: str_(r[11]), status: str_(r[12]), plan: str_(r[13]), expiry: isDate_(r[14]) ? ymd_(r[14]) : str_(r[14]),
    limit: parseInt(r[15], 10) || 0, created: str_(r[16]), salt: str_(r[17]), hash: str_(r[18]), notes: str_(r[19]), rootId: str_(r[20]) };
}
function loadCo_(cid) {
  cid = str_(cid).toUpperCase(); if (!cid) return null;
  var cache = C_(), k = 'co_' + cid, hit = cache.get(k); if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var sh = reg_().getSheetByName('Companies'), n = sh.getLastRow(); if (n < 2) return null;
  var v = sh.getRange(2, 1, n - 1, CO_H.length).getValues();
  for (var i = 0; i < v.length; i++) if (str_(v[i][0]).toUpperCase() === cid) { var co = coFromRow_(v[i], i + 2); cache.put(k, JSON.stringify(co), 60); return co; }
  return null;
}
function saveCo_(co) {
  var sh = reg_().getSheetByName('Companies');
  var r = [co.id, co.name, co.adminName, co.mobile, co.email, co.btype, co.expected, co.address, co.google, co.sheetId, co.photosId, co.reportsId, co.status, co.plan, co.expiry, co.limit,
    co.created, co.salt, co.hash, co.notes, co.rootId];
  if (!co.rowNum) co.rowNum = Math.max(sh.getLastRow(), 1) + 1;
  sh.getRange(co.rowNum, 1, 1, CO_H.length).setValues([r]);
  C_().remove('co_' + co.id);
}
function audit_(cid, actor, action, detail) {
  try { var sh = reg_().getSheetByName('Audit'), n = Math.max(sh.getLastRow(), 1) + 1; sh.getRange(n, 1, 1, 5).setValues([[new Date().toISOString(), cid, actor, action, str_(detail).slice(0, 300)]]); } catch (e) {}
}
function coLicence_(co) {
  var today = ymd_(new Date()), st = co.status.toLowerCase(), exp = co.expiry || null, left = exp ? dayNum_(exp) - dayNum_(today) : null;
  var base = { state: st, expiry: exp, days_left: left, valid: false, plan: co.plan };
  if (st === 'pending') { base.message = 'Company registration is not complete.'; return base; }
  if (st === 'suspended') { base.message = 'This company subscription is suspended. Contact your administrator.'; return base; }
  if (st !== 'trial' && st !== 'active') { base.message = 'This company subscription is not active.'; return base; }
  if (exp && exp < today) { base.state = 'expired'; base.message = 'This company subscription has expired. Existing records are kept; attendance cannot be marked.'; return base; }
  base.valid = true; base.message = (st === 'trial' ? 'Free trial' : 'Active') + (exp ? ' - ' + left + ' day' + (left === 1 ? '' : 's') + ' remaining (expires ' + exp + ')' : '');
  return base;
}
function needLicence_(co) { var l = coLicence_(co); if (!l.valid) throw fail_('LICENCE_' + l.state.toUpperCase(), l.message, l); return l; }

// ---------------- one-time owner setup ----------------
function setup() {
  var p = P_(); ['CLIENT_ID', 'CLIENT_SECRET', 'OWNER_PASSWORD'].forEach(function (k) { if (!p.getProperty(k)) throw new Error('Add Script property ' + k + ' first (Project Settings > Script properties). See GOOGLE_CLOUD_SETUP.md.'); });
  if (!p.getProperty('ENC_KEY')) p.setProperty('ENC_KEY', rnd_(48, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'));
  if (!p.getProperty('REGISTRY_ID')) {
    var ss = SpreadsheetApp.create(PRODUCT + ' - REGISTRY (owner only)'); p.setProperty('REGISTRY_ID', ss.getId());
    var c = ss.getSheets()[0]; c.setName('Companies'); c.getRange(1, 1, 1, CO_H.length).setValues([CO_H]);
    var a = ss.insertSheet('Audit'); a.getRange(1, 1, 1, 5).setValues([['Time', 'Company ID', 'Actor', 'Action', 'Detail']]);
  }
  return 'Setup complete. Registry: ' + p.getProperty('REGISTRY_ID') + '. Now Deploy > New deployment > Web app (Execute as: Me, Access: Anyone) and add its /exec URL as an authorised redirect URI in Google Cloud.';
}
function execUrl_() { return ScriptApp.getService().getUrl(); }

// ---------------- company registration (Google sign-in) ----------------
function stateSig_(type, cid) { return sha_(cfg_('ENC_KEY') + '|' + type + '|' + cid).slice(0, 20); }
function authUrl_(type, cid) {
  var q = { client_id: cfg_('CLIENT_ID'), redirect_uri: execUrl_(), response_type: 'code', scope: OAUTH_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: type + '.' + cid + '.' + stateSig_(type, cid) };
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
}
function validPin_(pin, min) { return /^[A-Za-z0-9@#_-]+$/.test(String(pin || '')) && String(pin).length >= (min || 4) && String(pin).length <= 20; }
function registerStart_(req) {
  var cache = C_(), n = parseInt(cache.get('reg_rate') || '0', 10); if (n >= 30) throw fail_('RATE_LIMIT', 'Too many registrations right now. Try again later.'); cache.put('reg_rate', String(n + 1), 3600);
  var f = { name: str_(req.company_name), adminName: str_(req.admin_name), mobile: str_(req.mobile), email: str_(req.email).toLowerCase(), btype: str_(req.business_type), expected: parseInt(req.employees, 10) || 0, address: str_(req.address) };
  if (!f.name || !f.adminName) throw fail_('BAD_REQUEST', 'Company name and administrator name are required.');
  if (!/^[0-9+ -]{8,15}$/.test(f.mobile)) throw fail_('BAD_REQUEST', 'Enter a valid mobile number.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) throw fail_('BAD_REQUEST', 'Enter a valid email address.');
  if (!validPin_(req.admin_pin, 6)) throw fail_('BAD_REQUEST', 'Administrator password must be 6-20 letters/numbers.');
  var cid; for (var t = 0; t < 10; t++) { cid = 'FA' + rnd_(5, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'); if (!loadCo_(cid)) break; }
  var salt = rnd_(16, 'abcdef0123456789');
  var co = { id: cid, name: f.name, adminName: f.adminName, mobile: f.mobile, email: f.email, btype: f.btype, expected: f.expected, address: f.address, google: '', sheetId: '', photosId: '', reportsId: '', status: 'Pending',
    plan: 'Trial', expiry: '', limit: 25, created: new Date().toISOString(), salt: salt, hash: sha_(salt + ':' + req.admin_pin), notes: '', rootId: '' };
  saveCo_(co); audit_(cid, f.email, 'REGISTER_START', f.name);
  return { company_id: cid, auth_url: authUrl_('R', cid) };
}
function registerStatus_(req) {
  var co = loadCo_(req.company_id); if (!co) throw fail_('NO_COMPANY', 'Company not found.');
  var p = C_().get('regerr_' + co.id);
  return { company_id: co.id, status: p ? 'ERROR' : (co.status === 'Pending' ? 'PENDING' : 'READY'), message: p || '' };
}
function reconnectUrl_(req) { var x = ctx_(req, ['ADMIN']); return { auth_url: authUrl_('C', x.co.id) }; }
function pageHtml_(title, msg, ok) {
  var h = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title></head><body style="font-family:sans-serif;text-align:center;padding:40px 20px">' +
    '<h2 style="color:' + (ok ? '#1b5e20' : '#b71c1c') + '">' + title + '</h2><p style="font-size:18px">' + msg + '</p></body></html>';
  return HtmlService.createHtmlOutput(h);
}
function oauthCallback_(p) {
  var parts = String(p.state || '').split('.'), type = parts[0], cid = parts[1], sig = parts[2];
  try {
    if (!cid || !sig || !safeEq_(sig, stateSig_(type, cid))) throw new Error('This sign-in link is not valid.');
    if (p.error) throw new Error('Google sign-in was cancelled.');
    var co = loadCo_(cid); if (!co) throw new Error('Company not found.');
    var tr = http_('post', 'https://oauth2.googleapis.com/token', { form: { code: p.code, client_id: cfg_('CLIENT_ID'), client_secret: cfg_('CLIENT_SECRET'), redirect_uri: execUrl_(), grant_type: 'authorization_code' } });
    if (tr.code !== 200 || !tr.json || !tr.json.access_token) throw new Error('Google did not accept the sign-in. Please try again.');
    if (!tr.json.refresh_token) throw new Error('Google did not grant offline access. Remove this app from your Google account permissions and register again.');
    var ui = http_('get', 'https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tr.json.access_token } });
    var email = (ui.json && ui.json.email) || '';
    if (type === 'R' && co.status === 'Pending') {
      createResources_(co, { id: co.id, _at: tr.json.access_token });
      P_().setProperty('RT_' + co.id, enc_(tr.json.refresh_token)); C_().remove('at_' + co.id);
      co.google = email; co.status = 'Trial'; co.plan = 'Trial';
      co.expiry = addDays_(ymd_(new Date()), parseInt(P_().getProperty('TRIAL_DAYS') || TRIAL_DAYS_DEFAULT, 10));
      saveCo_(co); audit_(co.id, email, 'REGISTER_DONE', co.name);
      C_().remove('regerr_' + co.id);
      return pageHtml_('Registration complete', 'Your Company ID is <b style="font-size:28px">' + co.id + '</b><br><br>Go back to the Field Attendance App and tap <b>Continue</b>.', true);
    }
    if (type === 'C' && co.google && email && co.google.toLowerCase() !== email.toLowerCase()) throw new Error('Please sign in with the same Google account that was used at registration (' + co.google + ').');
    P_().setProperty('RT_' + co.id, enc_(tr.json.refresh_token)); C_().remove('at_' + co.id);
    audit_(co.id, email, 'RECONNECT', '');
    return pageHtml_('Google account reconnected', 'You can go back to the Field Attendance App.', true);
  } catch (e) {
    if (cid) C_().put('regerr_' + cid, String(e.message || e).slice(0, 200), 600);
    return pageHtml_('Could not complete', String(e.message || e).replace(/[<>&]/g, ''), false);
  }
}
// Creates this company's spreadsheet + folders in the ADMIN'S Google account (using the admin's own token).
function createResources_(co, tmp) {
  var r = g_(tmp, 'post', API_S, { json: { properties: { title: co.name + ' - Field Attendance', locale: 'en_IN', timeZone: TZ },
    sheets: [{ properties: { title: 'Employees', gridProperties: { frozenRowCount: 1 } } }, { properties: { title: 'Attendance', gridProperties: { frozenRowCount: 1 } } }, { properties: { title: 'Info' } }] } });
  co.sheetId = r.json.spreadsheetId; tmp.sheetId = co.sheetId;
  g_(tmp, 'post', API_S + '/' + co.sheetId + '/values:batchUpdate', { json: { valueInputOption: 'RAW', data: [
    { range: 'Employees!A1', values: [EMP_H] }, { range: 'Attendance!A1', values: [ATT_H] },
    { range: 'Info!A1', values: [[PRODUCT], ['Company ID', co.id], ['Company', co.name], ['Do not rename the Employees / Attendance tabs or their header rows. Use the app to add employees and download reports.']] }] } });
  var mk = function (name, parent) { var b = { name: name, mimeType: 'application/vnd.google-apps.folder' }; if (parent) b.parents = [parent]; return g_(tmp, 'post', API_D + '/files?fields=id', { json: b }).json.id; };
  co.rootId = mk('Field Attendance - ' + co.name); co.photosId = mk('Attendance Photos', co.rootId); co.reportsId = mk('Reports', co.rootId);
  try { g_(tmp, 'patch', API_D + '/files/' + co.sheetId + '?addParents=' + co.rootId, { json: {} }); } catch (e) {}
}

// ---------------- sessions / login ----------------
function hashPin_(salt, pin) { return sha_(salt + ':' + pin); }
function newSession_(s) { var t = 'S' + rnd_(40, 'abcdefghijklmnopqrstuvwxyz0123456789'); C_().put('sess_' + t, JSON.stringify(s), SESSION_TTL); return t; }
function sess_(req) { var t = str_(req.token); if (!t) return null; var v = C_().get('sess_' + t); if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } }
function logoutSession_(req) { if (req.token) C_().remove('sess_' + req.token); return {}; }
function lockCheck_(key) { var n = parseInt(C_().get(key) || '0', 10); if (n >= MAX_FAILS) throw fail_('AUTH_LOCKED', 'Too many wrong attempts. Try again after 15 minutes.'); return n; }
function empFromRow_(r, rowNum) {
  return { row: rowNum, id: str_(r[0]), name: str_(r[1]), hash: str_(r[2]), salt: str_(r[3]), role: str_(r[4]) || 'Employee', status: str_(r[5]), expiry: str_(r[6]), mobile: str_(r[7]),
    designation: str_(r[8]), department: str_(r[9]), type: str_(r[10]), manager: str_(r[11]).toUpperCase(), site: str_(r[12]), lat: r[13] === '' ? NaN : parseFloat(r[13]), lng: r[14] === '' ? NaN : parseFloat(r[14]),
    radius: parseFloat(r[15]) || 200, created: str_(r[16]), updated: str_(r[17]), notes: str_(r[18]) };
}
function readEmps_(co) {
  var v = rd_(co, 'Employees!A2:S'), out = [];
  for (var i = 0; i < v.length; i++) { var e = empFromRow_(pad_([v[i]], EMP_H.length)[0], i + 2); if (e.id) out.push(e); }
  return out;
}
function empById_(co, id) {
  id = str_(id).toUpperCase(); var cache = C_(), k = 'er_' + co.id + '_' + id, hit = cache.get(k);
  if (hit) { try { var o = JSON.parse(hit); if (o.lat === null) o.lat = NaN; if (o.lng === null) o.lng = NaN; return o; } catch (e) {} }   // JSON turns NaN into null
  var all = readEmps_(co); for (var i = 0; i < all.length; i++) if (all[i].id.toUpperCase() === id) { cache.put(k, JSON.stringify(all[i]), 60); return all[i]; }
  return null;
}
function empLicence_(e) {
  var st = e.status.toLowerCase(), today = ymd_(new Date()), exp = e.expiry || null, left = exp ? dayNum_(exp) - dayNum_(today) : null;
  var b = { state: st || 'not_assigned', expiry: exp, days_left: left, valid: false };
  if (st === 'suspended') { b.message = 'Your account is suspended.'; return b; }
  if (st === 'revoked') { b.message = 'Your account has been revoked.'; return b; }
  if (st === 'inactive') { b.message = 'Your account is deactivated. Contact your administrator.'; return b; }
  if (st !== 'active' && st !== 'trial') { b.state = 'not_assigned'; b.message = 'No valid account. Contact your administrator.'; return b; }
  if (exp && exp < today) { b.state = 'expired'; b.message = 'Your account has expired.'; return b; }
  b.valid = true; b.message = (st === 'trial' ? 'Trial' : 'Active') + (exp ? ' - expires ' + exp : ''); return b;
}
function login_(req) {
  var cid = str_(req.company_id).toUpperCase(), id = str_(req.id).toUpperCase(), pin = str_(req.pin);
  if (!cid || !id || !pin) throw fail_('AUTH_BAD', 'Enter Company ID, user ID and PIN.');
  var fk = 'fail_' + cid + '_' + id, fails = lockCheck_(fk), co = loadCo_(cid);
  var bad = function () { C_().put(fk, String(fails + 1), 900); return fail_('AUTH_BAD', 'Incorrect Company ID, user ID or PIN.'); };
  if (!co || co.status === 'Pending') throw bad();
  var role, user = null;
  if (id === 'ADMIN') { if (!safeEq_(hashPin_(co.salt, pin), co.hash)) throw bad(); role = 'ADMIN'; }
  else {
    user = empById_(co, id); if (!user || !user.hash || !safeEq_(hashPin_(user.salt, pin), user.hash)) throw bad();
    var el = empLicence_(user); if (!el.valid) throw fail_('LICENCE_' + el.state.toUpperCase(), el.message, el);
    role = user.role.toLowerCase() === 'manager' ? 'MANAGER' : 'EMPLOYEE';
    if (role === 'EMPLOYEE') needLicence_(co);
  }
  C_().remove(fk);
  var token = newSession_({ c: co.id, id: id, role: role });
  if (role === 'ADMIN') audit_(co.id, 'ADMIN', 'LOGIN', '');
  var out = profile_(co, role, user); out.token = token; return out;
}
function profile_(co, role, user) {
  var out = { role: role, company: { id: co.id, name: co.name, licence: coLicence_(co) } };
  out.user = user ? { id: user.id, name: user.name, designation: user.designation, department: user.department, site: user.site, mobile: user.mobile, type: user.type } : { id: 'ADMIN', name: co.adminName };
  return out;
}
function ctx_(req, roles) {
  var s = sess_(req); if (!s) throw fail_('SESSION_EXPIRED', 'Please sign in again.');
  if (roles && roles.indexOf(s.role) < 0) throw fail_('FORBIDDEN', 'You do not have access to this.');
  if (s.role === 'OWNER') return { s: s, co: null, user: null };
  var co = loadCo_(s.c); if (!co) throw fail_('SESSION_EXPIRED', 'Please sign in again.');
  var user = null;
  if (s.role !== 'ADMIN') {
    user = empById_(co, s.id); if (!user) throw fail_('SESSION_EXPIRED', 'Please sign in again.');
    var el = empLicence_(user); if (!el.valid) { C_().remove('sess_' + req.token); throw fail_('LICENCE_' + el.state.toUpperCase(), el.message, el); }
  }
  return { s: s, co: co, user: user };
}
function me_(req) {
  var x = ctx_(req); var out = profile_(x.co, x.s.role, x.user);
  if (x.s.role === 'EMPLOYEE') {
    var a = attRecent_(x.co), open = findOpen_(a.v, x.user.id), today = ymd_(new Date()), last = null;
    for (var i = a.v.length - 1; i >= 1; i--) if (String(a.v[i][ea_('Employee ID')]) === x.user.id) { if (a.v[i][ea_('Date')] === today) last = a.v[i]; break; }
    out.open_session = open ? view_(open.row) : null; out.last_session = last ? view_(last) : null;
  }
  return out;
}

// ---------------- attendance engine (v2.5 logic over Google REST) ----------------
var EMPTY_ROW_ = [];
function attRecent_(co) {
  var last = lastRow_(co, 'Attendance'), v = [ATT_H.slice()], start = Math.max(2, last - RECENT_ROWS + 1);
  for (var i = 2; i < start; i++) v.push(EMPTY_ROW_);
  if (last >= start) { var rows = pad_(rd_(co, 'Attendance!A' + start + ':Z' + last), ATT_H.length); for (var k = 0; k < rows.length; k++) v.push(rows[k]); }
  return { v: v, last: last };
}
function findOpen_(v, id) { for (var i = v.length - 1; i >= 1; i--) if (String(v[i][ea_('Employee ID')]) === id && v[i][ea_('Status')] === 'OPEN') return { rowNum: i + 1, row: v[i] }; return null; }
function view_(r) {
  var num = function (x) { return x === '' || x === undefined ? null : parseFloat(x); };
  return { ref: r[ea_('Ref')], date: r[ea_('Date')], site: r[ea_('Site')], in_time: r[ea_('IN Time')], out_time: r[ea_('OUT Time')] || null, in_ts: r[ea_('IN Server Time')], out_ts: r[ea_('OUT Server Time')] || null,
    in_lat: num(r[ea_('IN Lat')]), in_lng: num(r[ea_('IN Long')]), out_lat: num(r[ea_('OUT Lat')]), out_lng: num(r[ea_('OUT Long')]), duration: r[ea_('Duration')] || null, status: r[ea_('Status')],
    in_on_site: r[ea_('IN On site?')], in_acc: r[ea_('IN Accuracy (m)')], out_acc: r[ea_('OUT Accuracy (m)')] };
}
function distanceM_(a, b, c, d) { var R = 6371000, rad = function (x) { return x * Math.PI / 180; }, dl = rad(c - a), dn = rad(d - b); var h = Math.sin(dl / 2) * Math.sin(dl / 2) + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dn / 2) * Math.sin(dn / 2); return 2 * R * Math.asin(Math.sqrt(h)); }
function checkLoc_(req) {
  var lat = Number(req.lat), lng = Number(req.lng), acc = Number(req.accuracy);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) throw fail_('BAD_LOCATION', 'Location was not received. Turn ON Location (GPS) and try again.');
  return { lat: lat, lng: lng, acc: isFinite(acc) && acc >= 0 ? acc : 9999 };
}
function accWarn_(loc) { return loc.acc > LOW_ACCURACY_WARN_M ? 'GPS accuracy was low (about ' + Math.round(loc.acc) + ' m). It is recorded as it is.' : null; }
function siteCheck_(emp, loc) {
  if (!isFinite(emp.lat) || !isFinite(emp.lng)) return { dist: '', on: 'n/a' };
  var d = Math.round(distanceM_(loc.lat, loc.lng, emp.lat, emp.lng)); return { dist: d, on: d <= emp.radius ? 'Yes' : 'No' };
}
function duration_(a, b) { var m = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000)); return Math.floor(m / 60) + 'h ' + ('0' + (m % 60)).slice(-2) + 'm'; }
function photoIdFromUrl_(u) { var m = /\/d\/([A-Za-z0-9_-]+)/.exec(String(u || '')) || /[?&]id=([A-Za-z0-9_-]+)/.exec(String(u || '')); return m ? m[1] : ''; }

function checkin_(req) {
  var x = ctx_(req, ['EMPLOYEE']), co = x.co, emp = x.user; needLicence_(co);
  var idem = String(req.idem || '').slice(0, 80); if (!idem) throw fail_('BAD_REQUEST', 'Missing request key.');
  var loc = checkLoc_(req), b64 = String(req.photo || '').replace(/^data:[^,]*,/, '');
  if (!b64) throw fail_('PHOTO_REQUIRED', 'A fresh photo is required.');
  if (b64.length > MAX_PHOTO_B64) throw fail_('PHOTO_TOO_LARGE', 'Photo is too large. Please retake.');
  var pre = attRecent_(co).v;
  for (var p = 1; p < pre.length; p++) if (pre[p][ea_('IN Key')] === idem && String(pre[p][ea_('Employee ID')]) === emp.id) return { duplicate: true, session: view_(pre[p]) };
  if (findOpen_(pre, emp.id)) throw fail_('ALREADY_CHECKED_IN', 'You already have an open attendance session. Please log out first.');
  // Photo goes to the company admin's private Drive folder BEFORE the lock (slow part), so many employees can check in at once.
  var now = new Date(), site = siteCheck_(emp, loc), ref = 'ATT-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
  var fname = ymd_(now) + '_' + emp.id + '_' + hm_(now).replace(':', '') + '_' + ref + '.jpg', B = 'fa' + rnd_(18, 'abcdef0123456789');
  var body = '--' + B + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name: fname, parents: [co.photosId] }) + '\r\n--' + B +
    '\r\nContent-Type: image/jpeg\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64 + '\r\n--' + B + '--';
  var up = g_(co, 'post', API_U + '/files?uploadType=multipart&fields=id,webViewLink', { body: body, ctype: 'multipart/related; boundary=' + B });
  var fileId = up.json.id, photoUrl = up.json.webViewLink || ('https://drive.google.com/file/d/' + fileId + '/view');
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var v = attRecent_(co).v;
    var trash = function () { try { g_(co, 'patch', API_D + '/files/' + fileId, { json: { trashed: true } }); } catch (e) {} };
    for (var i = 1; i < v.length; i++) if (v[i][ea_('IN Key')] === idem && String(v[i][ea_('Employee ID')]) === emp.id) { trash(); return { duplicate: true, session: view_(v[i]) }; }
    if (findOpen_(v, emp.id)) { trash(); throw fail_('ALREADY_CHECKED_IN', 'You already have an open attendance session. Please log out first.'); }
    var row = []; for (var k = 0; k < ATT_H.length; k++) row.push('');
    var set = function (n, val) { row[ea_(n)] = val; };
    set('Ref', ref); set('Date', ymd_(now)); set('Employee ID', emp.id); set('Name', emp.name); set('Site', emp.site); set('IN Time', hm_(now));
    set('IN Lat', loc.lat); set('IN Long', loc.lng); set('IN Accuracy (m)', Math.round(loc.acc)); set('IN Map', mapLink_(loc.lat, loc.lng)); set('Photo', photoUrl);
    set('IN Distance from site (m)', site.dist); set('IN On site?', site.on); set('Status', 'OPEN'); set('IN Server Time', now.toISOString()); set('IN Key', idem); set('Company ID', co.id);
    ap_(co, 'Attendance!A:Z', [row]);
    return { session: view_(row), warning: site.on === 'No' ? 'You are ' + site.dist + ' m from your assigned site. This was flagged for review.' : accWarn_(loc) };
  } finally { lock.releaseLock(); }
}
function checkout_(req) {
  var x = ctx_(req, ['EMPLOYEE']), co = x.co, emp = x.user; needLicence_(co);
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var idem = String(req.idem || '').slice(0, 80), v = attRecent_(co).v;
    if (idem) for (var i = 1; i < v.length; i++) if (v[i][ea_('OUT Key')] === idem && String(v[i][ea_('Employee ID')]) === emp.id) return { duplicate: true, session: view_(v[i]) };
    var open = findOpen_(v, emp.id); if (!open) throw fail_('NO_OPEN_SESSION', 'You have no open attendance session to log out of.');
    var loc = checkLoc_(req), now = new Date(), site = siteCheck_(emp, loc), r = open.row.slice();
    var set = function (n, val) { r[ea_(n)] = val; };
    set('OUT Time', hm_(now)); set('OUT Lat', loc.lat); set('OUT Long', loc.lng); set('OUT Accuracy (m)', Math.round(loc.acc)); set('OUT Map', mapLink_(loc.lat, loc.lng));
    set('OUT On site?', site.on); set('Duration', duration_(r[ea_('IN Server Time')], now)); set('Status', 'CLOSED'); set('OUT Server Time', now.toISOString()); set('OUT Key', idem);
    wr_(co, 'Attendance!A' + open.rowNum + ':Z' + open.rowNum, [r]);
    return { session: view_(r), warning: accWarn_(loc) };
  } finally { lock.releaseLock(); }
}
function history_(req) {
  var x = ctx_(req, ['EMPLOYEE', 'MANAGER']), v = attRecent_(x.co).v, out = [];
  for (var i = v.length - 1; i >= 1 && out.length < 60; i--) if (String(v[i][ea_('Employee ID')]) === x.user.id) out.push(view_(v[i]));
  return { sessions: out };
}

// ---------------- scope + readers for admin / manager ----------------
function scopeEmps_(x) {   // admin: everyone; manager: only employees assigned to that manager
  var all = readEmps_(x.co); if (x.s.role === 'ADMIN') return all;
  return all.filter(function (e) { return e.manager === x.user.id.toUpperCase(); });
}
function rowsFrom_(co, fromDate) {   // rows with Date >= fromDate (rows are appended in date order)
  var dates = rd_(co, 'Attendance!B:B'), first = 0;
  for (var i = 1; i < dates.length; i++) if (String(dates[i][0]) >= fromDate) { first = i + 1; break; }
  if (!first) return [];
  return pad_(rd_(co, 'Attendance!A' + first + ':Z' + dates.length), ATT_H.length);
}
function byId_(emps) { var m = {}; emps.forEach(function (e) { m[e.id] = e; }); return m; }
function sessionHours_(r) {
  var a = r[ea_('IN Server Time')], b = r[ea_('OUT Server Time')];
  if (r[ea_('Status')] !== 'CLOSED' || !a || !b) return 0;
  var h = (new Date(b).getTime() - new Date(a).getTime()) / 3600000; return h > 0 ? h : 0;
}
function rowView_(r, e) {
  var out = r[ea_('Status')] === 'CLOSED', num = function (x) { return x === '' || x === undefined ? null : x; };
  return { ref: r[ea_('Ref')], date: r[ea_('Date')], id: r[ea_('Employee ID')], name: r[ea_('Name')], department: e ? e.department : '', designation: e ? e.designation : '', manager: e ? e.manager : '',
    site: r[ea_('Site')], in_time: r[ea_('IN Time')], in_lat: num(r[ea_('IN Lat')]), in_lng: num(r[ea_('IN Long')]), in_acc: num(r[ea_('IN Accuracy (m)')]), in_map: r[ea_('IN Map')],
    photo_id: photoIdFromUrl_(r[ea_('Photo')]), in_dist: num(r[ea_('IN Distance from site (m)')]), in_on: r[ea_('IN On site?')],
    out_time: out ? r[ea_('OUT Time')] : null, out_lat: out ? num(r[ea_('OUT Lat')]) : null, out_lng: out ? num(r[ea_('OUT Long')]) : null, out_acc: out ? num(r[ea_('OUT Accuracy (m)')]) : null,
    out_map: out ? r[ea_('OUT Map')] : '', hours: out ? round2_(sessionHours_(r)) : null, status: r[ea_('Status')] };
}
function dashboard_(req) {
  var x = ctx_(req, ['ADMIN', 'MANAGER']), today = ymd_(new Date()), monthStart = today.slice(0, 8) + '01';
  var emps = scopeEmps_(x).filter(function (e) { return e.role.toLowerCase() !== 'manager'; }), ids = byId_(emps);
  var rows = rowsFrom_(x.co, monthStart).filter(function (r) { return ids[String(r[ea_('Employee ID')])]; });
  var active = emps.filter(function (e) { return empLicence_(e).valid; }), pres = {}, open = 0, done = 0, missed = 0, monthDays = {};
  rows.forEach(function (r) {
    var d = r[ea_('Date')], id = r[ea_('Employee ID')]; monthDays[id + '|' + d] = 1;
    if (d === today) { pres[id] = 1; if (r[ea_('Status')] === 'OPEN') open++; else done++; } else if (r[ea_('Status')] === 'OPEN') missed++;
  });
  var presentToday = Object.keys(pres).length;
  return { today: today, total_employees: emps.length, active_employees: active.length, present_today: presentToday, absent_today: Math.max(0, active.length - presentToday),
    logged_in_now: open, completed_checkouts: done, missed_checkouts: missed, month_attendance_days: Object.keys(monthDays).length, licence: coLicence_(x.co) };
}
function attList_(req) {
  var x = ctx_(req, ['ADMIN', 'MANAGER']), today = ymd_(new Date()), from = str_(req.from) || today, to = str_(req.to) || from;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw fail_('BAD_REQUEST', 'Dates must be YYYY-MM-DD.');
  var emps = scopeEmps_(x), ids = byId_(emps), f = { emp: str_(req.emp).toUpperCase(), dept: str_(req.dept), des: str_(req.designation), mgr: str_(req.manager).toUpperCase(), site: str_(req.site) };
  var rows = rowsFrom_(x.co, from).filter(function (r) {
    var d = String(r[ea_('Date')]), e = ids[String(r[ea_('Employee ID')])]; if (!e || d > to) return false;
    return (!f.emp || e.id.toUpperCase() === f.emp) && (!f.dept || e.department === f.dept) && (!f.des || e.designation === f.des) && (!f.mgr || e.manager === f.mgr) && (!f.site || e.site === f.site);
  });
  var out = rows.slice(-500).reverse().map(function (r) { return rowView_(r, ids[String(r[ea_('Employee ID')])]); });
  return { from: from, to: to, count: out.length, rows: out };
}
// Photos are private in the admin's Drive; the app shows them only through this authorised call.
function photo_(req) {
  var x = ctx_(req, ['ADMIN', 'MANAGER']), id = str_(req.photo_id); if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw fail_('BAD_REQUEST', 'Bad photo.');
  var meta = g_(x.co, 'get', API_D + '/files/' + id + '?fields=name,parents').json;
  if (!meta || !meta.parents || meta.parents.indexOf(x.co.photosId) < 0) throw fail_('FORBIDDEN', 'You do not have access to this photo.');
  var eid = String(meta.name || '').split('_')[1] || '';
  if (x.s.role === 'MANAGER') { var e = empById_(x.co, eid); if (!e || e.manager !== x.user.id.toUpperCase()) throw fail_('FORBIDDEN', 'This employee is not assigned to you.'); }
  var r = g_(x.co, 'get', API_D + '/files/' + id + '?alt=media');
  return { image: 'data:image/jpeg;base64,' + Utilities.base64Encode(r.resp.getContent()) };
}

// ---------------- monthly reports (data; the app builds the Excel file) ----------------
var MONTHS_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function reportMonth_(req) {
  var x = ctx_(req, ['ADMIN', 'MANAGER']), m = /^(\d{4})-(\d{2})$/.exec(str_(req.month) || ymd_(new Date()).slice(0, 7)); if (!m || +m[2] < 1 || +m[2] > 12) throw fail_('BAD_REQUEST', 'Month must be YYYY-MM.');
  var year = +m[1], month = +m[2], days = new Date(Date.UTC(year, month, 0)).getUTCDate(), ym = m[0], today = ymd_(new Date());
  var f = { emp: str_(req.emp).toUpperCase(), dept: str_(req.dept), mgr: str_(req.manager).toUpperCase() };
  var emps = scopeEmps_(x).filter(function (e) { return e.role.toLowerCase() !== 'manager' && (!f.emp || e.id.toUpperCase() === f.emp) && (!f.dept || e.department === f.dept) && (!f.mgr || e.manager === f.mgr); });
  var ids = byId_(emps), rows = rowsFrom_(x.co, ym + '-01').filter(function (r) { return String(r[ea_('Date')]).indexOf(ym + '-') === 0 && ids[String(r[ea_('Employee ID')])]; });
  var byDay = {}, has = {}; rows.forEach(function (r) { var k = r[ea_('Employee ID')] + '|' + parseInt(String(r[ea_('Date')]).slice(8, 10), 10); (byDay[k] = byDay[k] || []).push(r); has[r[ea_('Employee ID')]] = 1; });
  var dows = []; for (var d = 1; d <= days; d++) dows.push(new Date(Date.UTC(year, month - 1, d)).getUTCDay());
  var include = emps.filter(function (e) { return e.status.toLowerCase() !== 'inactive' || has[e.id]; });
  var pa = [], hours = [];
  include.forEach(function (e) {
    var codes = [], hv = [], cnt = { P: 0, L: 0, WO: 0, MC: 0 }, tot = 0, worked = 0;
    for (var d = 1; d <= days; d++) {
      var date = ym + '-' + ('0' + d).slice(-2), sun = dows[d - 1] === 0, lst = byDay[e.id + '|' + d] || [], closed = lst.filter(function (r) { return r[ea_('Status')] === 'CLOSED'; }), code = '', hr = '';
      if (lst.length) { var h = 0; lst.forEach(function (r) { h += sessionHours_(r); }); tot += h; if (closed.length) { code = 'P'; hr = round2_(h); worked++; } else { code = 'MC'; hr = 'MC'; } }
      else if (date <= today) code = sun ? 'WO' : 'L';
      if (code) cnt[code]++; codes.push(code); hv.push(hr);
    }
    pa.push({ id: e.id, name: e.name, department: e.department, codes: codes, P: cnt.P, L: cnt.L, WO: cnt.WO, MC: cnt.MC, hours: round2_(tot) });
    hours.push({ id: e.id, name: e.name, values: hv, total: round2_(tot), days_worked: worked });
  });
  var loc = rows.slice().sort(function (a, b) { return (String(a[ea_('Date')]) + a[ea_('IN Time')] + a[ea_('Employee ID')]).localeCompare(String(b[ea_('Date')]) + b[ea_('IN Time')] + b[ea_('Employee ID')]); })
    .map(function (r) { return rowView_(r, ids[String(r[ea_('Employee ID')])]); });
  return { company: x.co.name, month: ym, month_name: MONTHS_[month - 1], year: year, days: days, dows: dows, today: today,
    employees: include.map(function (e) { return { id: e.id, name: e.name, department: e.department, designation: e.designation, manager: e.manager, site: e.site }; }), pa: pa, hours: hours, location: loc };
}

// ---------------- employee management (admin) ----------------
function empPublic_(e) { return { id: e.id, name: e.name, role: e.role, status: e.status, expiry: e.expiry, mobile: e.mobile, designation: e.designation, department: e.department, type: e.type, manager: e.manager, site: e.site,
  lat: isFinite(e.lat) ? e.lat : null, lng: isFinite(e.lng) ? e.lng : null, radius: e.radius }; }
function empList_(req) { var x = ctx_(req, ['ADMIN', 'MANAGER']), l = scopeEmps_(x).map(empPublic_); return { employees: l, types: EMP_TYPES, statuses: EMP_STATUS }; }
function nextId_(all, role) {
  var prefix = role === 'Manager' ? 'M' : 'E', max = 0; all.forEach(function (e) { var m = new RegExp('^' + prefix + '(\\d+)$').exec(e.id.toUpperCase()); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  return prefix + ('00' + (max + 1)).slice(-3);
}
function empRow_(e) {
  var r = []; for (var i = 0; i < EMP_H.length; i++) r.push('');
  var set = function (n, v) { r[ee_(n)] = v; };
  set('Employee ID', e.id); set('Name', e.name); set('PIN Hash', e.hash); set('PIN Salt', e.salt); set('Role', e.role); set('Status', e.status); set('Expiry Date', e.expiry); set('Mobile', e.mobile);
  set('Designation', e.designation); set('Department', e.department); set('Employee Type', e.type); set('Manager ID', e.manager); set('Site', e.site);
  set('Site Lat', isFinite(e.lat) ? e.lat : ''); set('Site Long', isFinite(e.lng) ? e.lng : ''); set('Radius (m)', e.radius); set('Created', e.created); set('Updated', e.updated); set('Notes', e.notes);
  return r;
}
function fieldsFrom_(req, e, all) {
  var has = function (k) { return req[k] !== undefined; };
  if (has('name')) { e.name = str_(req.name); if (!e.name) throw fail_('BAD_REQUEST', 'Employee name is required.'); }
  if (has('mobile')) { e.mobile = str_(req.mobile); if (e.mobile && !/^[0-9+ -]{8,15}$/.test(e.mobile)) throw fail_('BAD_REQUEST', 'Enter a valid mobile number.'); }
  ['designation', 'department', 'site', 'notes'].forEach(function (k) { if (has(k)) e[k] = str_(req[k]); });
  if (has('type')) { e.type = str_(req.type); if (e.type && EMP_TYPES.indexOf(e.type) < 0) throw fail_('BAD_REQUEST', 'Unknown employee type.'); }
  if (has('manager')) { e.manager = str_(req.manager).toUpperCase(); if (e.manager) { var m = all.filter(function (z) { return z.id.toUpperCase() === e.manager && z.role.toLowerCase() === 'manager'; })[0]; if (!m) throw fail_('BAD_REQUEST', 'Assigned manager not found.'); } }
  if (has('lat')) e.lat = req.lat === '' || req.lat === null ? NaN : parseFloat(req.lat);
  if (has('lng')) e.lng = req.lng === '' || req.lng === null ? NaN : parseFloat(req.lng);
  if (isFinite(e.lat) && (Math.abs(e.lat) > 90 || !isFinite(e.lng) || Math.abs(e.lng) > 180)) throw fail_('BAD_REQUEST', 'Site latitude/longitude are not valid.');
  if (has('radius')) e.radius = Math.min(50000, Math.max(20, parseFloat(req.radius) || 200));
  if (has('status')) { if (EMP_STATUS.indexOf(req.status) < 0) throw fail_('BAD_REQUEST', 'Unknown status.'); e.status = req.status; }
  if (has('expiry')) { e.expiry = str_(req.expiry); if (e.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(e.expiry)) throw fail_('BAD_REQUEST', 'Expiry must be YYYY-MM-DD.'); }
  return e;
}
function empAdd_(req) {
  var x = ctx_(req, ['ADMIN']), co = x.co; needLicence_(co);
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var all = readEmps_(co), role = str_(req.role).toLowerCase() === 'manager' ? 'Manager' : 'Employee';
    var activeCount = all.filter(function (e) { return ['inactive', 'revoked'].indexOf(e.status.toLowerCase()) < 0; }).length;
    if (co.limit && activeCount >= co.limit) throw fail_('LIMIT_REACHED', 'Your plan allows ' + co.limit + ' users. Contact the app owner to increase the limit.');
    var pin = str_(req.pin) || rnd_(6, '0123456789'); if (!validPin_(pin, 4)) throw fail_('BAD_REQUEST', 'PIN must be 4-20 letters/numbers.');
    var now = new Date().toISOString(), salt = rnd_(16, 'abcdef0123456789');
    var e = { id: nextId_(all, role), name: '', hash: hashPin_(salt, pin), salt: salt, role: role, status: 'Active', expiry: ymd_(new Date(Date.now() + 365 * 86400000)), mobile: '', designation: '', department: '', type: '', manager: '', site: '',
      lat: NaN, lng: NaN, radius: 200, created: now, updated: now, notes: '' };
    fieldsFrom_(req, e, all); if (!e.name) throw fail_('BAD_REQUEST', 'Employee name is required.');
    ap_(co, 'Employees!A:S', [empRow_(e)]); C_().remove('er_' + co.id + '_' + e.id.toUpperCase()); audit_(co.id, 'ADMIN', 'EMP_ADD', e.id + ' ' + e.name);
    return { employee: empPublic_(e), pin: pin };
  } finally { lock.releaseLock(); }
}
function empUpdate_(req) {
  var x = ctx_(req, ['ADMIN']), co = x.co; needLicence_(co);
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var all = readEmps_(co), id = str_(req.id).toUpperCase(), e = all.filter(function (z) { return z.id.toUpperCase() === id; })[0]; if (!e) throw fail_('NOT_FOUND', 'Employee not found.');
    fieldsFrom_(req, e, all); e.updated = new Date().toISOString();
    wr_(co, 'Employees!A' + e.row + ':S' + e.row, [empRow_(e)]); C_().remove('er_' + co.id + '_' + e.id.toUpperCase()); audit_(co.id, 'ADMIN', 'EMP_UPDATE', e.id + ' ' + (req.status || ''));
    return { employee: empPublic_(e) };
  } finally { lock.releaseLock(); }
}
function empResetPin_(req) {
  var x = ctx_(req, ['ADMIN']), co = x.co; needLicence_(co);
  var lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    var all = readEmps_(co), id = str_(req.id).toUpperCase(), e = all.filter(function (z) { return z.id.toUpperCase() === id; })[0]; if (!e) throw fail_('NOT_FOUND', 'Employee not found.');
    var pin = str_(req.pin) || rnd_(6, '0123456789'); if (!validPin_(pin, 4)) throw fail_('BAD_REQUEST', 'PIN must be 4-20 letters/numbers.');
    e.salt = rnd_(16, 'abcdef0123456789'); e.hash = hashPin_(e.salt, pin); e.updated = new Date().toISOString();
    wr_(co, 'Employees!A' + e.row + ':S' + e.row, [empRow_(e)]); C_().remove('er_' + co.id + '_' + e.id.toUpperCase()); C_().remove('fail_' + co.id + '_' + e.id.toUpperCase()); audit_(co.id, 'ADMIN', 'EMP_RESET_PIN', e.id);
    return { id: e.id, pin: pin };
  } finally { lock.releaseLock(); }
}
function companyInfo_(req) {
  var x = ctx_(req, ['ADMIN', 'MANAGER']), co = x.co;
  return { id: co.id, name: co.name, admin_name: co.adminName, mobile: co.mobile, email: co.email, business_type: co.btype, address: co.address, google_account: co.google,
    plan: co.plan, status: co.status, expiry: co.expiry, employee_limit: co.limit, licence: coLicence_(co) };
}

// ---------------- owner console (separate login; password only in Script Properties) ----------------
function ownerLogin_(req) {
  var fk = 'fail_OWNER', fails = lockCheck_(fk), pw = str_(req.password);
  if (!pw || !safeEq_(pw, cfg_('OWNER_PASSWORD'))) { C_().put(fk, String(fails + 1), 900); throw fail_('AUTH_BAD', 'Incorrect owner password.'); }
  C_().remove(fk); return { role: 'OWNER', token: newSession_({ c: '', id: 'OWNER', role: 'OWNER' }) };
}
function coPublic_(co) {
  var l = coLicence_(co);
  return { id: co.id, name: co.name, admin_name: co.adminName, mobile: co.mobile, email: co.email, google_account: co.google, business_type: co.btype, status: co.status, plan: co.plan,
    expiry: co.expiry, days_left: l.days_left, valid: l.valid, employee_limit: co.limit, expected_employees: co.expected, created: co.created };
}
function ownerList_(req) {
  ctx_(req, ['OWNER']); var sh = reg_().getSheetByName('Companies'), n = sh.getLastRow(), out = [];
  if (n >= 2) { var v = sh.getRange(2, 1, n - 1, CO_H.length).getValues(); for (var i = 0; i < v.length; i++) { if (!str_(v[i][0])) continue; out.push(coPublic_(coFromRow_(v[i], i + 2))); } }
  return { companies: out };
}
function ownerUpdate_(req) {
  ctx_(req, ['OWNER']); var co = loadCo_(req.company_id); if (!co) throw fail_('NO_COMPANY', 'Company not found.');
  if (req.status !== undefined) { if (['Trial', 'Active', 'Suspended', 'Expired'].indexOf(req.status) < 0) throw fail_('BAD_REQUEST', 'Unknown status.'); if (co.status === 'Pending') throw fail_('BAD_REQUEST', 'Registration is not complete.'); co.status = req.status; }
  if (req.plan !== undefined) co.plan = str_(req.plan).slice(0, 40);
  if (req.limit !== undefined) { var l = parseInt(req.limit, 10); if (!(l >= 1 && l <= 100000)) throw fail_('BAD_REQUEST', 'Employee limit must be 1-100000.'); co.limit = l; }
  if (req.expiry !== undefined) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.expiry))) throw fail_('BAD_REQUEST', 'Expiry must be YYYY-MM-DD.'); co.expiry = req.expiry; }
  if (req.extend_days !== undefined) {
    var d = parseInt(req.extend_days, 10); if (!(d >= 1 && d <= 3650)) throw fail_('BAD_REQUEST', 'Days must be 1-3650.');
    var base = co.expiry && co.expiry > ymd_(new Date()) ? co.expiry : ymd_(new Date()); co.expiry = addDays_(base, d); if (co.status === 'Expired') co.status = 'Active';
  }
  if (req.notes !== undefined) co.notes = str_(req.notes).slice(0, 200);
  saveCo_(co); audit_(co.id, 'OWNER', 'OWNER_UPDATE', JSON.stringify({ s: req.status, p: req.plan, l: req.limit, e: req.expiry, x: req.extend_days }));
  return { company: coPublic_(co) };
}
function ownerDetail_(req) {
  ctx_(req, ['OWNER']); var co = loadCo_(req.company_id); if (!co) throw fail_('NO_COMPANY', 'Company not found.');
  var users = 0, last = '', err = '';
  try { users = Math.max(0, lastRow_(co, 'Employees') - 1); var d = rd_(co, 'Attendance!B:B'); last = d.length > 1 ? String(d[d.length - 1][0]) : ''; } catch (e) { err = e.message; }
  return { company: coPublic_(co), users: users, last_attendance_date: last, google_error: err };
}

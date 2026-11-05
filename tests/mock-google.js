'use strict';
// In-memory fake of the Google services used by apps-script/Code.gs:
//   Apps Script services (SpreadsheetApp for the OWNER registry, PropertiesService, CacheService, LockService, UrlFetchApp ...)
//   and Google REST (OAuth token endpoint, Sheets v4, Drive v3) as seen by UrlFetchApp, with per-account isolation:
//   a token can only touch files created in ITS OWN Google account. This tests OUR logic; it cannot prove real Google behaves identically.
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');

function chain(target) { const p = new Proxy(target, { get: (t, k) => (k in t ? t[k] : (k === 'then' ? undefined : () => p)) }); return p; }
class Sheet {   // owner registry sheet (SpreadsheetApp)
  constructor(name) { this.name = name; this.g = []; }
  _ensure(r, c) { while (this.g.length < r) this.g.push([]); for (let i = 0; i < r; i++) while (this.g[i].length < c) this.g[i].push(''); }
  getLastRow() { let n = 0; this.g.forEach((r, i) => { if (r.some(v => v !== '' && v != null)) n = i + 1; }); return n; }
  getRange(r, c, nr = 1, nc = 1) {
    const s = this;
    return chain({
      getValues: () => { s._ensure(r + nr - 1, c + nc - 1); return Array.from({ length: nr }, (_, i) => s.g[r - 1 + i].slice(c - 1, c - 1 + nc)); },
      setValues: (v) => { s._ensure(r + nr - 1, c + nc - 1); v.forEach((row, i) => row.forEach((x, j) => { s.g[r - 1 + i][c - 1 + j] = x; })); },
    });
  }
  setName(n) { this.name = n; return this; }
}
const colIdx = (L) => L.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
function parseRange(rg) {
  const m = /^([^!]+)!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(rg); if (!m) throw new Error('bad range ' + rg);
  return { tab: m[1], c1: colIdx(m[2]), r1: m[3] ? +m[3] : 1, c2: m[4] ? colIdx(m[4]) : colIdx(m[2]), r2: m[5] ? +m[5] : null };
}
const lastNonEmpty = (g) => { let n = 0; g.forEach((r, i) => { if (r.some(v => v !== '' && v != null)) n = i + 1; }); return n; };

function makeEnv() {
  const props = { CLIENT_ID: 'cid.apps.googleusercontent.com', CLIENT_SECRET: 'sec', OWNER_PASSWORD: 'owner-pass-1' }, cache = {}, log = [];
  const revoked = new Set(), atOwner = {}; let n = 0;
  const sheetsById = {}, filesById = {}, registry = { sheets: [] }; let regCounter = 0;
  const ownerOf = (auth) => atOwner[String(auth || '').replace('Bearer ', '')] || null;
  const issueAt = (email) => { const t = 'AT-' + (++n) + '-' + email; atOwner[t] = email; return t; };
  const resp = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : (body && body.__bytes ? '' : JSON.stringify(body))), getContent: () => (body && body.__bytes ? Array.from(body.__bytes).map(b => (b << 24) >> 24) : []) });
  const gerr = (code, msg) => resp(code, { error: { code, message: msg } });
  const qs = (u) => Object.fromEntries(new URL(u).searchParams.entries());
  const writeCells = (t, r1, c1, vals) => vals.forEach((row, i) => row.forEach((x, j) => { while (t.g.length < r1 + i) t.g.push([]); const rr = t.g[r1 - 1 + i]; while (rr.length < c1 + j + 1) rr.push(''); rr[c1 + j] = x; }));

  function fetch(url, o = {}) {
    const method = (o.method || 'get').toLowerCase(), u = new URL(url), headers = o.headers || {};
    log.push(method.toUpperCase() + ' ' + u.origin + u.pathname);
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) {
      const f = o.payload || {};
      if (f.client_id !== props.CLIENT_ID || f.client_secret !== props.CLIENT_SECRET) return resp(401, { error: 'invalid_client' });
      if (f.grant_type === 'authorization_code') {
        if (f.redirect_uri !== 'https://script.google.com/macros/s/TEST/exec') return resp(400, { error: 'redirect_uri_mismatch' });
        const m = /^CODE:(.+?)(:NORT)?$/.exec(f.code || ''); if (!m) return resp(400, { error: 'invalid_grant' });
        return resp(200, Object.assign({ access_token: issueAt(m[1]), expires_in: 3600 }, m[2] ? {} : { refresh_token: 'RT:' + m[1] }));
      }
      if (f.grant_type === 'refresh_token') {
        const m = /^RT:(.+)$/.exec(f.refresh_token || ''); if (!m || revoked.has(m[1])) return resp(400, { error: 'invalid_grant' });
        return resp(200, { access_token: issueAt(m[1]), expires_in: 3600 });
      }
    }
    if (u.href.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) { const e = ownerOf(headers.Authorization); return e ? resp(200, { email: e }) : gerr(401, 'bad token'); }
    const who = ownerOf(headers.Authorization); if (!who) return gerr(401, 'Invalid Credentials');
    if (u.href.startsWith('https://sheets.googleapis.com/v4/spreadsheets')) {
      const rest = u.pathname.replace('/v4/spreadsheets', '').replace(/^\//, '');
      if (!rest && method === 'post') {
        const b = JSON.parse(o.payload), id = 'SS' + (++n); sheetsById[id] = { owner: who, tabs: {}, title: b.properties.title };
        b.sheets.forEach(s => { sheetsById[id].tabs[s.properties.title] = { g: [] }; });
        return resp(200, { spreadsheetId: id });
      }
      const parts = rest.split('/'), id = parts[0], ss = sheetsById[id];
      if (!ss || ss.owner !== who) return gerr(404, 'Requested entity was not found.');
      if (parts[1] === 'values:batchUpdate') { JSON.parse(o.payload).data.forEach(d => { const r = parseRange(d.range); writeCells(ss.tabs[r.tab], r.r1, r.c1, d.values); }); return resp(200, {}); }
      const tail = decodeURIComponent(parts.slice(2).join('/')), isAppend = tail.endsWith(':append'), rg = parseRange(isAppend ? tail.slice(0, -7) : tail), t = ss.tabs[rg.tab];
      if (!t) return gerr(400, 'Unable to parse range: ' + tail);
      if (method === 'get') {
        const last = lastNonEmpty(t.g), re = Math.min(rg.r2 || last, last), out = [];
        for (let r = rg.r1; r <= re; r++) { const row = (t.g[r - 1] || []).slice(rg.c1, rg.c2 + 1); while (row.length && (row[row.length - 1] === '' || row[row.length - 1] == null)) row.pop(); out.push(row); }
        return resp(200, out.length ? { range: tail, majorDimension: 'ROWS', values: out } : { range: tail });
      }
      if (method === 'put') { const vals = JSON.parse(o.payload).values; writeCells(t, rg.r1, rg.c1, vals); return resp(200, { updatedRows: vals.length }); }
      if (method === 'post' && isAppend) {
        const vals = JSON.parse(o.payload).values, start = lastNonEmpty(t.g) + 1; writeCells(t, start, 0, vals);
        return resp(200, { updates: { updatedRange: rg.tab + '!A' + start + ':Z' + (start + vals.length - 1), updatedRows: vals.length } });
      }
    }
    if (u.href.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
      const B = /boundary=(.+)$/.exec(o.contentType || '')[1], parts = o.payload.split('--' + B).filter(x => x.trim() && x.trim() !== '--');
      const meta = JSON.parse(parts[0].split('\r\n\r\n')[1].trim()), b64 = parts[1].split('\r\n\r\n')[1].trim(), par = filesById[(meta.parents || [])[0]];
      if (!par || par.owner !== who) return gerr(404, 'File not found: parent');
      const id = 'FILE' + String(++n).padStart(14, '0'); filesById[id] = { owner: who, name: meta.name, parents: meta.parents, bytes: Buffer.from(b64, 'base64'), trashed: false };
      return resp(200, { id, webViewLink: 'https://drive.google.com/file/d/' + id + '/view' });
    }
    if (u.href.startsWith('https://www.googleapis.com/drive/v3/files')) {
      const rest = u.pathname.replace('/drive/v3/files', '').replace(/^\//, '');
      if (!rest && method === 'post') { const b = JSON.parse(o.payload), id = 'FOLDER' + String(++n).padStart(14, '0'); filesById[id] = { owner: who, name: b.name, parents: b.parents || [], folder: true, trashed: false }; return resp(200, { id }); }
      const f = filesById[rest]; if (!f || f.owner !== who) return gerr(404, 'File not found: ' + rest);
      if (method === 'patch') { const b = JSON.parse(o.payload || '{}'); if (b.trashed) f.trashed = true; const q = qs(url); if (q.addParents) f.parents.push(q.addParents); return resp(200, { id: rest }); }
      if (method === 'get') { const q = qs(url); if (q.alt === 'media') return resp(200, { __bytes: f.bytes }); return resp(200, { name: f.name, parents: f.parents }); }
    }
    return gerr(404, 'unhandled ' + method + ' ' + url);
  }

  const env = {
    console,
    SpreadsheetApp: {
      create: () => { const id = 'REG' + (++regCounter); registry.sheets.push(new Sheet('Sheet1')); registry.ss = chain({ getId: () => id, getSheets: () => registry.sheets, getSheetByName: (nm) => registry.sheets.find(s => s.name === nm) || null, insertSheet: (nm) => { const s = new Sheet(nm); registry.sheets.push(s); return s; } }); return registry.ss; },
      openById: () => registry.ss,
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = String(v); }, remove: (k) => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }) },
    HtmlService: { createHtmlOutput: (h) => ({ getContent: () => h }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ getContent: () => s, setMimeType() { return this; } }) },
    UrlFetchApp: { fetch },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      formatDate: (d, tz, f) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
        return f.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('hh', p.hour).replace('mm', p.minute).replace(' a', '');
      },
      getUuid: () => crypto.randomUUID(),
      base64Encode: (x) => (typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x.map(b => (b + 256) % 256))).toString('base64'),
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')).map(b => (b << 24) >> 24),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes.map(b => (b + 256) % 256)).toString('utf8'), getBytes: () => bytes }),
      computeDigest: (_, s) => Array.from(crypto.createHash('sha256').update(s).digest()).map(b => (b << 24) >> 24),
      computeHmacSha256Signature: (v, k) => Array.from(crypto.createHmac('sha256', k).update(v).digest()).map(b => (b << 24) >> 24),
    },
  };
  return { env, props, cache, log, sheetsById, filesById, registry, revoke: (e) => revoked.add(e), unrevoke: (e) => revoked.delete(e) };
}
function load() {
  const E = makeEnv(), ctx = vm.createContext(E.env);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8') + '\n;this.__x={doGet,doPost,setup,ATT_H,EMP_H,CO_H,ymd_,addDays_};', ctx);
  const x = ctx.__x;
  const api = (body) => JSON.parse(x.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  const oauth = (query) => x.doGet({ parameter: query }).getContent();
  return Object.assign(E, { x, api, oauth, ctx });
}
module.exports = { load, makeEnv };

'use strict';
// Runs the REAL Capacitor Android bridge (native-bridge.js) against a fake phone, then runs the app's own
// plugin()/getLocation()/takePhoto() code on top of it. Proves the JS side talks to the native plugins correctly.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const bridgeSrc = fs.readFileSync(path.join(__dirname, '../node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '../www/app.js'), 'utf8');

function boot(fake) {
  const sent = [];
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON, Date, Math, Error, Object, Proxy, Array, String, Number, navigator: {}, document: { addEventListener() {}, createElement() { return {}; } }, Document: function () {}, HTMLDocument: function () {}, Element: function () {}, HTMLElement: function () {}, Event: function () {}, CustomEvent: function () {}, XMLHttpRequest: function () {}, FormData: function () {}, Headers: function () {}, Request: function () {}, Response: function () {}, fetch: async () => ({}), URL, Blob, TextEncoder, TextDecoder, Uint8Array, Map, Set, Symbol, Reflect, WeakMap, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64') });
  ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx;
  ctx.androidBridge = { postMessage: (m) => { const d = JSON.parse(m); sent.push(d); setTimeout(() => fake(d, (r) => ctx.Capacitor.fromNative({ pluginId: d.pluginId, methodName: d.methodName, callbackId: d.callbackId, ...r })), 5); } };
  ctx.Capacitor = { PluginHeaders: [{ name: 'Camera', methods: [] }, { name: 'Geolocation', methods: [] }] };
  vm.runInContext(bridgeSrc + '\n;', ctx);
  // pull the app's own helper functions out of app.js and run them on top of the real bridge
  const pick = (from, to) => appSrc.slice(appSrc.indexOf(from), appSrc.indexOf(to));
  const code = 'const cap = Capacitor; const isNative = cap.isNativePlatform();\n' + pick('const plugin = (name)', 'class ApiError') + '\n' +
    pick('async function getLocation()', 'async function takePhoto()').replace('const WAIT_MS = 12000', 'const WAIT_MS = 400').replace('EARLY_MS = 5000', 'EARLY_MS = 200') + '\n' +
    pick('async function takePhoto()', '// Resize to 800px') + '\n;this.__t = { getLocation, takePhoto, plugin, isNative };';
  vm.runInContext(code, ctx);
  return { t: ctx.__t, sent };
}
const pos = (acc) => ({ timestamp: Date.now(), coords: { latitude: 18.52, longitude: 73.85, accuracy: acc } });

test('bridge reports a native Android platform', () => { const { t } = boot(() => {}); assert.equal(t.isNative, true); assert.ok(t.plugin('Camera')); });
test('GPS: asks for permission, keeps the most accurate reading, stops the watch', async () => {
  const { t, sent } = boot((d, reply) => {
    if (d.methodName === 'checkPermissions') reply({ success: true, data: { location: 'prompt' } });
    else if (d.methodName === 'requestPermissions') reply({ success: true, data: { location: 'granted' } });
    else if (d.methodName === 'watchPosition') [83, 56, 70].forEach((a, i) => setTimeout(() => reply({ success: true, data: pos(a), save: true }), 20 * (i + 1)));
    else if (d.methodName === 'clearWatch') reply({ success: true, data: {} });
  });
  const r = await t.getLocation();
  assert.equal(r.accuracy, 56);
  const names = sent.map(s => s.methodName); assert.ok(names.includes('requestPermissions')); assert.ok(names.includes('watchPosition')); assert.ok(names.includes('clearWatch'));
  assert.equal(sent.find(s => s.methodName === 'watchPosition').options.enableHighAccuracy, true);
});
test('GPS: permission denied gives a clear message', async () => {
  const { t } = boot((d, reply) => { if (d.methodName === 'checkPermissions') reply({ success: true, data: { location: 'denied' } }); else if (d.methodName === 'requestPermissions') reply({ success: true, data: { location: 'denied' } }); });
  await assert.rejects(t.getLocation(), /permission is denied/i);
});
test('GPS: location switched off gives a useful message', async () => {
  const { t } = boot((d, reply) => {
    if (d.methodName === 'checkPermissions') reply({ success: true, data: { location: 'granted' } });
    else if (d.methodName === 'watchPosition') reply({ success: false, error: { message: 'Location services are not enabled' }, save: true });
    else reply({ success: true, data: {} });
  });
  await assert.rejects(t.getLocation(), /Turn ON Location/);
});
test('Camera: asks permission, opens live camera (never gallery), returns a data URL', async () => {
  const { t, sent } = boot((d, reply) => {
    if (d.methodName === 'checkPermissions') reply({ success: true, data: { camera: 'prompt' } });
    else if (d.methodName === 'requestPermissions') reply({ success: true, data: { camera: 'granted' } });
    else if (d.methodName === 'getPhoto') reply({ success: true, data: { base64String: 'QUJD', format: 'jpeg' } });
  });
  const url = await t.takePhoto(); assert.equal(url, 'data:image/jpeg;base64,QUJD');
  const o = sent.find(s => s.methodName === 'getPhoto').options;
  assert.equal(o.source, 'CAMERA'); assert.equal(o.direction, 'FRONT'); assert.equal(o.saveToGallery, false);
  assert.deepEqual(sent.find(s => s.methodName === 'requestPermissions').options.permissions, ['camera']);
});
test('Camera: user cancelling returns null, denied permission throws', async () => {
  let b = boot((d, reply) => { if (d.methodName === 'checkPermissions') reply({ success: true, data: { camera: 'granted' } }); else reply({ success: false, error: { message: 'User cancelled photos app' } }); });
  assert.equal(await b.t.takePhoto(), null);
  b = boot((d, reply) => { if (d.methodName === 'checkPermissions') reply({ success: true, data: { camera: 'denied' } }); else if (d.methodName === 'requestPermissions') reply({ success: true, data: { camera: 'denied' } }); });
  await assert.rejects(b.t.takePhoto(), /Camera permission is denied/);
});

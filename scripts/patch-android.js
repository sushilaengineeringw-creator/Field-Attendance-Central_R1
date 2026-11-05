'use strict';
// Run AFTER `npx cap add android`. Adds permissions and installs the committed debug keystore
// so every CI build is signed with the same key (lets new APKs update an installed one).
const fs = require('fs'), path = require('path'), os = require('os');
const root = path.join(__dirname, '..');
const mf = path.join(root, 'android/app/src/main/AndroidManifest.xml');
let x = fs.readFileSync(mf, 'utf8');
const perms = ['android.permission.INTERNET', 'android.permission.CAMERA', 'android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'];
const feats = ['<uses-feature android:name="android.hardware.camera" android:required="false" />', '<uses-feature android:name="android.hardware.location.gps" android:required="false" />'];
const add = [];
for (const p of perms) if (!x.includes(`"${p}"`)) add.push(`    <uses-permission android:name="${p}" />`);
for (const f of feats) if (!x.includes(f.match(/android:name="([^"]+)"/)[1])) add.push('    ' + f);
if (add.length) x = x.replace('</manifest>', add.join('\n') + '\n</manifest>');
if (!x.includes('usesCleartextTraffic')) x = x.replace('<application', '<application\n        android:usesCleartextTraffic="false"');
fs.writeFileSync(mf, x);
const ks = path.join(root, 'debug.keystore');
if (fs.existsSync(ks)) { const d = path.join(os.homedir(), '.android'); fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(ks, path.join(d, 'debug.keystore')); console.log('debug keystore installed'); }
console.log('AndroidManifest patched');
// Version for Play Store (versionCode must increase with every upload) and optional release signing for the AAB.
const pkg = require(path.join(root, 'package.json')), bg = path.join(root, 'android/app/build.gradle');
let b = fs.readFileSync(bg, 'utf8');
b = b.replace(/versionCode\s+\d+/, 'versionCode ' + (process.env.GITHUB_RUN_NUMBER || '1')).replace(/versionName\s+"[^"]*"/, 'versionName "' + pkg.version + '"');
if (process.env.KEYSTORE_PATH && !b.includes('signingConfigs.release')) {
  b += `
android {
    signingConfigs { release { storeFile file(System.getenv('KEYSTORE_PATH')); storePassword System.getenv('KEYSTORE_PASSWORD'); keyAlias System.getenv('KEY_ALIAS'); keyPassword System.getenv('KEY_PASSWORD') } }
    buildTypes { release { signingConfig signingConfigs.release } }
}
`;
  console.log('release signing configured');
}
fs.writeFileSync(bg, b);
console.log('versionCode/versionName set');


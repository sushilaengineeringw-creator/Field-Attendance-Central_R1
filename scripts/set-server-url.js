'use strict';
// Usage: node scripts/set-server-url.js https://your-server.example.com
const fs = require('fs'), path = require('path');
const url = (process.argv[2] || '').trim().replace(/\/+$/, '');
if (!/^https:\/\/[^\s/]+/.test(url)) { console.error('SERVER_URL must be an https:// address'); process.exit(1); }
const f = path.join(__dirname, '../www/config.js');
fs.writeFileSync(f, `window.APP_CONFIG = { SERVER_URL: ${JSON.stringify(url)} };\n`);
console.log('www/config.js ->', url);

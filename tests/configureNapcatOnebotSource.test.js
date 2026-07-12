const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'configure-napcat-onebot.js'),
  'utf8'
);

assert.match(source, /const HTTP_REVERSE_SECRET = String\(process\.env\.NAPCAT_HTTP_REVERSE_SECRET \|\| HTTP_ACTION_SECRET\)\.trim\(\)/);
assert.match(source, /httpServers:[\s\S]*?token: HTTP_ACTION_SECRET/);
assert.match(source, /httpClients:[\s\S]*?token: HTTP_REVERSE_SECRET/);
assert.match(source, /NAPCAT_HTTP_REVERSE_SECRET: HTTP_REVERSE_SECRET/);

console.log('configureNapcatOnebotSource.test.js passed');

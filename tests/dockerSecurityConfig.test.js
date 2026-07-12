const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

assert.match(
  dockerfile,
  /RUN mkdir -p \/app\/data \/app\/logs[\s\S]*chown -R node:node \/app\/data \/app\/logs/
);
assert.match(dockerfile, /\nUSER node\s*\n[\s\S]*CMD \["npm", "start"\]/);
assert.match(
  compose,
  /127\.0\.0\.1:\$\{NAPCAT_HTTP_REVERSE_PORT:-3002\}:\$\{NAPCAT_HTTP_REVERSE_PORT:-3002\}/
);
assert.match(
  compose,
  /127\.0\.0\.1:\$\{WEB_PORT:-3005\}:\$\{WEB_PORT:-3005\}/
);

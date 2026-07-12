'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.resolve(__dirname, '../scripts/check-staged-secrets.js');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-secret-scan-'));

try {
  git(tempRoot, ['init', '-q']);
  fs.writeFileSync(path.join(tempRoot, 'safe.js'), "module.exports = 'safe';\n");
  git(tempRoot, ['add', 'safe.js']);

  const safe = spawnSync(process.execPath, [script, '--all'], {
    cwd: tempRoot,
    encoding: 'utf8'
  });
  assert.strictEqual(safe.status, 0, safe.stderr);
  assert.match(safe.stdout, /tracked secret scan passed/);

  const fakeSecret = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
  fs.writeFileSync(path.join(tempRoot, 'credential.js'), `module.exports = '${fakeSecret}';\n`);
  git(tempRoot, ['add', 'credential.js']);

  const blocked = spawnSync(process.execPath, [script, '--all'], {
    cwd: tempRoot,
    encoding: 'utf8'
  });
  assert.strictEqual(blocked.status, 1);
  assert.match(blocked.stderr, /credential\.js:1 OpenAI-style API key/);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('tracked secret scan tests passed');

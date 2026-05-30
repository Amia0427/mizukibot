const assert = require('assert');
const fs = require('fs');
const path = require('path');

const bridge = require('../scripts/local-command-bridge');
const leakedToken = ['FUcQwzRjozCZIAp', 'UYZyd-B4zjkXj0Ief80_i618xH8Q'].join('');

assert.doesNotThrow(() => bridge.buildCommandSpec('node', { args: ['scripts/console.js'] }));
assert.throws(() => bridge.buildCommandSpec('node', { args: ['-e', 'console.log(1)'] }), /inline execution/);
assert.throws(() => bridge.buildCommandSpec('python', { args: ['-c', 'print(1)'] }), /inline execution/);
assert.throws(() => bridge.buildCommandSpec('py', { args: ['-c', 'print(1)'] }), /inline execution/);

assert.throws(() => bridge.buildCommandSpec('node', { cwd: '..', args: ['scripts/console.js'] }), /cwd outside allowed roots/);
assert.throws(() => bridge.buildCommandSpec('node', { cwd: '\\\\server\\share', args: ['scripts/console.js'] }), /cwd outside allowed roots/);

assert.doesNotThrow(() => bridge.buildCommandSpec('npm', { args: ['run', 'test'] }));
assert.throws(() => bridge.buildCommandSpec('npm', { args: ['exec', 'some-package'] }), /npm command is not allowed/);
assert.throws(() => bridge.buildCommandSpec('npx', { args: ['some-package'] }), /npx command is not allowed/);
assert.throws(() => bridge.buildCommandSpec('npx', { args: ['--no-install', 'https://example.com/pkg'] }), /remote packages/);

assert.strictEqual(bridge.normalizeTimeoutMs(999999), 120000);
assert.strictEqual(bridge.normalizeTimeoutMs(500), 1000);

const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'local-command-bridge.js'), 'utf8');
const scriptsDir = path.join(__dirname, '..', 'scripts');
for (const fileName of fs.readdirSync(scriptsDir)) {
  if (!/\.(js|ps1|cmd|sh)$/i.test(fileName)) continue;
  const source = fs.readFileSync(path.join(scriptsDir, fileName), 'utf8');
  assert.ok(!source.includes(leakedToken), fileName);
}
assert.ok(bridgeSource.includes('console.warn'));

process.env.CLI_API_TOKEN = 'test-token';
const hapiSpecWithToken = bridge.buildCommandSpec('hapi', { args: ['--version'] });
assert.strictEqual(hapiSpecWithToken, null);
delete process.env.CLI_API_TOKEN;

console.log('localCommandBridgeSecurity.test.js passed');

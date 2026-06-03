const assert = require('assert');
const fs = require('fs');
const path = require('path');

const bridge = require('../scripts/local-command-bridge');
const config = require('../config');
const envRuntime = require('../config/envRuntime');
const bridgeClient = require('../utils/localCommandBridgeClient');
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

{
  const Module = require('module');
  const originalLoad = Module._load;
  const calls = [];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'dotenv') {
      return {
        config(options = {}) {
          calls.push(options);
          return {};
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    envRuntime.loadEnvironment(path.join(__dirname, '..'));
    assert.ok(calls[0].path.endsWith(`${path.sep}.env`));
  } finally {
    Module._load = originalLoad;
  }
}

{
  const originalToken = config.LOCAL_COMMAND_BRIDGE_TOKEN;
  config.LOCAL_COMMAND_BRIDGE_TOKEN = '';
  const req = { headers: {} };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
  let nextCalled = false;
  bridge.ensureAuthorized(req, res, () => { nextCalled = true; });
  try {
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.payload.error, 'local_command_bridge_token_missing');
  } finally {
    config.LOCAL_COMMAND_BRIDGE_TOKEN = originalToken;
  }
}

{
  const originalToken = config.LOCAL_COMMAND_BRIDGE_TOKEN;
  config.LOCAL_COMMAND_BRIDGE_TOKEN = 'expected-token';
  try {
    const badReq = { headers: { authorization: 'Bearer wrong-token' } };
    const badRes = {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return this;
      }
    };
    bridge.ensureAuthorized(badReq, badRes, () => {});
    assert.strictEqual(badRes.statusCode, 401);

    const goodReq = { headers: { authorization: 'Bearer expected-token' } };
    const goodRes = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return this;
      }
    };
    let nextCalled = false;
    bridge.ensureAuthorized(goodReq, goodRes, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  } finally {
    config.LOCAL_COMMAND_BRIDGE_TOKEN = originalToken;
  }
}

{
  const originalToken = config.LOCAL_COMMAND_BRIDGE_TOKEN;
  const originalEnabled = config.LOCAL_COMMAND_BRIDGE_ENABLED;
  const originalUrl = config.LOCAL_COMMAND_BRIDGE_URL;
  config.LOCAL_COMMAND_BRIDGE_ENABLED = true;
  config.LOCAL_COMMAND_BRIDGE_URL = 'http://127.0.0.1:3210';
  try {
    config.LOCAL_COMMAND_BRIDGE_TOKEN = '';
    assert.strictEqual(bridgeClient.hasBridgeToken(), false);
    assert.strictEqual(bridgeClient.isLocalCommandBridgeEnabled(), false);

    config.LOCAL_COMMAND_BRIDGE_TOKEN = 'expected-token';
    assert.strictEqual(bridgeClient.hasBridgeToken(), true);
    assert.strictEqual(bridgeClient.isLocalCommandBridgeEnabled(), true);
  } finally {
    config.LOCAL_COMMAND_BRIDGE_TOKEN = originalToken;
    config.LOCAL_COMMAND_BRIDGE_ENABLED = originalEnabled;
    config.LOCAL_COMMAND_BRIDGE_URL = originalUrl;
  }
}

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

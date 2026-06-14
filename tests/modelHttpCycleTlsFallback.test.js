const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const {
  isCycleTlsMisdirectedRequest
} = require('../src/model/http/model-post.chunk');

const cycleTls421 = new Error('Request failed with status code 421');
cycleTls421.response = {
  status: 421,
  request: {
    transport: 'cycletls'
  }
};
assert.strictEqual(isCycleTlsMisdirectedRequest(cycleTls421), true);

const axios421 = new Error('Request failed with status code 421');
axios421.response = {
  status: 421,
  request: {
    transport: 'axios'
  }
};
assert.strictEqual(isCycleTlsMisdirectedRequest(axios421), false);

const cycleTls403 = new Error('Request failed with status code 403');
cycleTls403.response = {
  status: 403,
  request: {
    transport: 'cycletls'
  }
};
assert.strictEqual(isCycleTlsMisdirectedRequest(cycleTls403), false);

const defaultStatusProbe = spawnSync(process.execPath, ['-e', `
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'dotenv') return { config() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  process.chdir(${JSON.stringify(path.resolve(__dirname, '..'))});
  process.env.API_KEY = 'test-key';
  process.env.API_BASE_URL = 'https://example.test/v1/chat/completions';
  process.env.AI_MODEL = 'test-model';
  process.env.MODEL_TLS_IMPERSONATION_ENABLED = '';
  process.env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED = '';
  process.env.MODEL_TLS_IMPERSONATION_FALLBACK_ENABLED = '';
  const status = require('./src/model/http/model-post.chunk').getModelHttpTransportStatus();
  console.log(JSON.stringify(status));
`], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    MODEL_TLS_IMPERSONATION_ENABLED: '',
    MODEL_TLS_IMPERSONATION_STREAM_ENABLED: '',
    MODEL_TLS_IMPERSONATION_FALLBACK_ENABLED: ''
  },
  encoding: 'utf8'
});

assert.strictEqual(defaultStatusProbe.status, 0, defaultStatusProbe.stderr);
const defaultStatus = JSON.parse(defaultStatusProbe.stdout.trim());
assert.strictEqual(defaultStatus.tlsImpersonationEnabled, false);
assert.strictEqual(defaultStatus.tlsImpersonationStreamEnabled, false);
assert.strictEqual(defaultStatus.tlsImpersonationFallbackEnabled, true);

const enabledStatusProbe = spawnSync(process.execPath, ['-e', `
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'dotenv') return { config() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.API_KEY = 'test-key';
  process.env.API_BASE_URL = 'https://example.test/v1/chat/completions';
  process.env.AI_MODEL = 'test-model';
  process.env.MODEL_TLS_IMPERSONATION_ENABLED = 'true';
  process.env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED = '';
  const status = require('./src/model/http/model-post.chunk').getModelHttpTransportStatus();
  console.log(JSON.stringify(status));
`], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    MODEL_TLS_IMPERSONATION_ENABLED: 'true',
    MODEL_TLS_IMPERSONATION_STREAM_ENABLED: ''
  },
  encoding: 'utf8'
});

assert.strictEqual(enabledStatusProbe.status, 0, enabledStatusProbe.stderr);
const enabledStatus = JSON.parse(enabledStatusProbe.stdout.trim());
assert.strictEqual(enabledStatus.tlsImpersonationEnabled, true);
assert.strictEqual(enabledStatus.tlsImpersonationStreamEnabled, false);

console.log('modelHttpCycleTlsFallback.test.js passed');

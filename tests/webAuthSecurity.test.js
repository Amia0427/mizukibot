const assert = require('assert');

const config = require('../config');
const { __test } = require('../web/server');

function makeReq({ method = 'GET', remoteAddress = '127.0.0.1', headers = {} } = {}) {
  return {
    method,
    headers,
    socket: { remoteAddress }
  };
}

async function withConfig(patch, fn) {
  const snapshot = {};
  for (const key of Object.keys(patch)) snapshot[key] = config[key];
  Object.assign(config, patch);
  try {
    return await fn();
  } finally {
    Object.assign(config, snapshot);
  }
}

(async () => {
await withConfig({ WEB_TOKEN: 'secret-token', WEB_BIND_HOST: '127.0.0.1' }, async () => {
  assert.strictEqual(__test.checkWebAuth(makeReq({ headers: { 'x-web-token': 'secret-token' } })), true);
  assert.strictEqual(__test.checkWebAuth(makeReq({ headers: { authorization: 'Bearer secret-token' } })), true);
  assert.strictEqual(__test.checkWebAuth(makeReq({ remoteAddress: '203.0.113.10' })), false);
});

await withConfig({ WEB_TOKEN: '', WEB_BIND_HOST: '127.0.0.1', WEB_LOCAL_ONLY_WITHOUT_TOKEN: true }, async () => {
  assert.strictEqual(__test.checkWebAuth(makeReq({ method: 'GET', remoteAddress: '127.0.0.1' }), { host: '127.0.0.1', port: 3005 }), true);
  assert.strictEqual(__test.checkWebAuth(makeReq({ method: 'GET', remoteAddress: '203.0.113.10' }), { host: '127.0.0.1', port: 3005 }), false);
});

await withConfig({ WEB_TOKEN: '', WEB_BIND_HOST: '0.0.0.0', WEB_LOCAL_ONLY_WITHOUT_TOKEN: true }, async () => {
  assert.strictEqual(__test.checkWebAuth(makeReq({ method: 'GET', remoteAddress: '127.0.0.1' }), { host: '0.0.0.0', port: 3005 }), false);
});

await withConfig({ WEB_TOKEN: '', WEB_BIND_HOST: '127.0.0.1', WEB_LOCAL_ONLY_WITHOUT_TOKEN: false }, async () => {
  assert.strictEqual(__test.checkWebAuth(makeReq({ method: 'GET', remoteAddress: '127.0.0.1' }), { host: '127.0.0.1', port: 3005 }), false);
});

await withConfig({ MODEL_ENDPOINT_ALLOW_LOCAL_HTTP: false }, async () => {
  const safe = await __test.getSettingsEndpointError({
    api_base_url: 'https://example.com/v1/chat/completions'
  }, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  assert.strictEqual(safe, '');

  const httpError = await __test.getSettingsEndpointError({
    api_base_url: 'http://example.com/v1/chat/completions'
  }, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  assert.match(httpError, /API_BASE_URL.*https/);

  const privateError = await __test.getSettingsEndpointError({
    api_base_url: 'https://example.com/v1/chat/completions',
    ai_router_base_url: 'https://router.example.com/v1/chat/completions'
  }, {
    lookup: async (hostname) => [{ address: hostname === 'router.example.com' ? '10.0.0.5' : '93.184.216.34', family: 4 }]
  });
  assert.match(privateError, /AI_ROUTER_BASE_URL.*disallowed/);
});

console.log('webAuthSecurity.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

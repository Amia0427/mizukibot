const assert = require('assert');

const config = require('../config');
const { createWebApp } = require('../web/server');
const { createSecurityHeaders, isRequestSecure } = require('../web/securityHeaders');

function runMiddleware(req, options = {}) {
  const headers = new Map();
  const res = {
    locals: {},
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    }
  };
  let nextCalled = false;
  createSecurityHeaders(options)(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(nextCalled, true);
  return { headers, nonce: res.locals.cspNonce };
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

async function listen(app) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function assertSecurityHeaders(response) {
  const csp = response.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'nonce-[^']+'/);
  assert.strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(response.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(response.headers.get('cache-control'), 'no-store');
  return csp.match(/script-src 'nonce-([^']+)'/)[1];
}

(async () => {
  const plainRequest = {
    headers: { 'x-forwarded-proto': 'https' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  const plain = runMiddleware(plainRequest);
  assert.ok((plain.headers.get('content-security-policy') || '').includes(`script-src 'nonce-${plain.nonce}'`));
  assert.strictEqual(plain.headers.has('strict-transport-security'), false);

  const directHttps = runMiddleware({
    headers: {},
    socket: { encrypted: true, remoteAddress: '203.0.113.9' }
  });
  assert.match(directHttps.headers.get('strict-transport-security') || '', /max-age=/);

  const trustedProxyHttps = runMiddleware(plainRequest, { trustProxyHops: 1 });
  assert.match(trustedProxyHttps.headers.get('strict-transport-security') || '', /max-age=/);
  assert.strictEqual(isRequestSecure(plainRequest, { trustProxyHops: 1 }), true);
  assert.strictEqual(isRequestSecure({
    headers: { 'x-forwarded-proto': 'https' },
    socket: { remoteAddress: '198.51.100.5' }
  }, { trustProxyHops: 1 }), false);

  await withConfig({
    WEB_BIND_HOST: '127.0.0.1',
    WEB_LOCAL_ONLY_WITHOUT_TOKEN: false,
    WEB_TOKEN: 'headers-login-secret',
    WEB_TRUST_PROXY_HOPS: 0
  }, async () => {
    const runtime = createWebApp();
    const server = await listen(runtime.app);
    try {
      const health = await fetch(`${server.baseUrl}/healthz`);
      const healthNonce = assertSecurityHeaders(health);
      const live = await fetch(`${server.baseUrl}/live`);
      const liveNonce = assertSecurityHeaders(live);
      assert.strictEqual(live.status, 200);
      const ready = await fetch(`${server.baseUrl}/ready`);
      const readyNonce = assertSecurityHeaders(ready);
      assert.strictEqual(ready.status, 200);

      const unauthorized = await fetch(`${server.baseUrl}/api/bot-thinking`);
      const unauthorizedNonce = assertSecurityHeaders(unauthorized);
      assert.strictEqual(unauthorized.status, 401);

      const loginPage = await fetch(`${server.baseUrl}/login`);
      const loginNonce = assertSecurityHeaders(loginPage);
      const loginHtml = await loginPage.text();
      assert.ok(loginHtml.includes(`nonce="${loginNonce}"`));

      const rootRedirect = await fetch(`${server.baseUrl}/`, { redirect: 'manual' });
      const redirectNonce = assertSecurityHeaders(rootRedirect);
      assert.strictEqual(rootRedirect.status, 302);

      const login = await fetch(`${server.baseUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
        body: JSON.stringify({ token: 'headers-login-secret' })
      });
      const loginResponseNonce = assertSecurityHeaders(login);
      const cookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];

      const root = await fetch(`${server.baseUrl}/`, { headers: { Cookie: cookie } });
      const rootNonce = assertSecurityHeaders(root);
      const rootHtml = await root.text();
      assert.ok(rootHtml.includes(`nonce="${rootNonce}"`));

      const api = await fetch(`${server.baseUrl}/api/bot-thinking`, { headers: { Cookie: cookie } });
      const apiNonce = assertSecurityHeaders(api);
      assert.strictEqual(api.status, 200);

      const nonces = [healthNonce, liveNonce, readyNonce, unauthorizedNonce, loginNonce, redirectNonce, loginResponseNonce, rootNonce, apiNonce];
      assert.strictEqual(new Set(nonces).size, nonces.length);
      assert.strictEqual(health.headers.has('strict-transport-security'), false);
    } finally {
      await server.close();
      runtime.sessionManager.stop();
    }
  });

  await withConfig({
    WEB_BIND_HOST: '127.0.0.1',
    WEB_LOCAL_ONLY_WITHOUT_TOKEN: false,
    WEB_TOKEN: 'secure-cookie-secret',
    WEB_TRUST_PROXY_HOPS: 1
  }, async () => {
    const runtime = createWebApp();
    const server = await listen(runtime.app);
    try {
      const publicOrigin = server.baseUrl.replace('http://', 'https://');
      const login = await fetch(`${server.baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: publicOrigin,
          'X-Forwarded-Proto': 'https'
        },
        body: JSON.stringify({ token: 'secure-cookie-secret' })
      });
      assert.strictEqual(login.status, 201);
      assert.match(login.headers.get('set-cookie') || '', /; Secure/i);
      assert.match(login.headers.get('strict-transport-security') || '', /max-age=/);
    } finally {
      await server.close();
      runtime.sessionManager.stop();
    }
  });

  console.log('webSecurityHeaders.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

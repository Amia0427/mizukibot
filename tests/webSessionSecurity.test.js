const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const { createWebSessionManager } = require('../web/sessionManager');
const { createWebApp } = require('../web/server');
const { createLoginRateLimiter } = require('../web/auth');

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

(async () => {
  let now = 1000;
  const manager = createWebSessionManager({
    maxSessions: 2,
    now: () => now,
    ttlMs: 1000
  });
  const first = manager.create();
  const second = manager.create();
  assert.notStrictEqual(first.id, second.id);
  assert.strictEqual(manager.has(first.id), true);
  manager.revoke(first.id);
  assert.strictEqual(manager.has(first.id), false);
  const third = manager.create();
  manager.create();
  assert.strictEqual(manager.size(), 2);
  now = third.expiresAt + 1;
  assert.strictEqual(manager.has(third.id), false);
  manager.stop();

  await withConfig({
    WEB_BIND_HOST: '127.0.0.1',
    WEB_LOCAL_ONLY_WITHOUT_TOKEN: false,
    WEB_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: 2,
    WEB_LOGIN_RATE_LIMIT_MAX_CLIENTS: 100,
    WEB_LOGIN_RATE_LIMIT_WINDOW_MS: 60000,
    WEB_SESSION_MAX_ACTIVE: 8,
    WEB_SESSION_TTL_MS: 60000,
    WEB_TOKEN: 'session-login-secret',
    WEB_VIEWER_TOKEN: 'viewer-login-secret',
    WEB_LOGIN_RATE_LIMIT_STATE_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-web-session-')), 'rate-limit.json'),
    WEB_TRUST_PROXY_HOPS: 0
  }, async () => {
    let restartCookie = '';
    const firstRuntime = createWebApp();
    const firstServer = await listen(firstRuntime.app);
    try {
      const health = await fetch(`${firstServer.baseUrl}/healthz`);
      assert.strictEqual(health.status, 200);

      const unauthorized = await fetch(`${firstServer.baseUrl}/api/bot-thinking`, {
        headers: { 'x-web-token': 'session-login-secret' }
      });
      assert.strictEqual(unauthorized.status, 401);
      const queryToken = await fetch(`${firstServer.baseUrl}/api/bot-thinking?token=session-login-secret`);
      assert.strictEqual(queryToken.status, 401);

      const loginPage = await fetch(`${firstServer.baseUrl}/login`);
      const loginHtml = await loginPage.text();
      assert.strictEqual(loginPage.status, 200);
      assert.ok(!loginHtml.includes('localStorage'));
      assert.ok(!loginHtml.includes('session-login-secret'));

      const crossOriginLogin = await fetch(`${firstServer.baseUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:1' },
        body: JSON.stringify({ token: 'session-login-secret' })
      });
      assert.strictEqual(crossOriginLogin.status, 403);

      const login = await fetch(`${firstServer.baseUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: firstServer.baseUrl },
        body: JSON.stringify({ token: 'session-login-secret' })
      });
      assert.strictEqual(login.status, 201);
      const setCookie = login.headers.get('set-cookie') || '';
      assert.match(setCookie, /^mizuki_web_session=[A-Za-z0-9_-]+;/);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
      assert.match(setCookie, /Max-Age=60/i);
      assert.match(setCookie, /Path=\//i);
      assert.ok(!setCookie.includes('session-login-secret'));
      const firstCookie = setCookie.split(';', 1)[0];

      const rotatedLogin = await fetch(`${firstServer.baseUrl}/api/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: firstCookie,
          Origin: firstServer.baseUrl
        },
        body: JSON.stringify({ token: 'session-login-secret' })
      });
      assert.strictEqual(rotatedLogin.status, 201);
      const cookie = (rotatedLogin.headers.get('set-cookie') || '').split(';', 1)[0];
      assert.notStrictEqual(cookie, firstCookie);
      const rotatedOut = await fetch(`${firstServer.baseUrl}/api/bot-thinking`, {
        headers: { Cookie: firstCookie }
      });
      assert.strictEqual(rotatedOut.status, 401);

      const authorized = await fetch(`${firstServer.baseUrl}/api/bot-thinking`, {
        headers: { Cookie: cookie }
      });
      assert.strictEqual(authorized.status, 200);

      const viewerLogin = await fetch(`${firstServer.baseUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: firstServer.baseUrl },
        body: JSON.stringify({ token: 'viewer-login-secret' })
      });
      assert.strictEqual(viewerLogin.status, 201);
      const viewerCookie = (viewerLogin.headers.get('set-cookie') || '').split(';', 1)[0];
      const viewerRead = await fetch(`${firstServer.baseUrl}/api/settings`, {
        headers: { Cookie: viewerCookie }
      });
      assert.strictEqual(viewerRead.status, 200);
      const viewerWrite = await fetch(`${firstServer.baseUrl}/api/memory-governance/rebuild`, {
        method: 'POST',
        headers: { Cookie: viewerCookie, Origin: firstServer.baseUrl }
      });
      assert.strictEqual(viewerWrite.status, 403);

      const panel = await fetch(`${firstServer.baseUrl}/`, {
        headers: { Cookie: cookie }
      });
      const panelHtml = await panel.text();
      assert.strictEqual(panel.status, 200);
      assert.ok(!panelHtml.includes('localStorage'));
      assert.ok(!panelHtml.includes('x-web-token'));

      const missingOrigin = await fetch(`${firstServer.baseUrl}/api/memory-governance/rebuild`, {
        method: 'POST',
        headers: { Cookie: cookie }
      });
      assert.strictEqual(missingOrigin.status, 403);
      const wrongOrigin = await fetch(`${firstServer.baseUrl}/api/memory-governance/rebuild`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'http://127.0.0.1:1' }
      });
      assert.strictEqual(wrongOrigin.status, 403);

      const duplicateCookie = await fetch(`${firstServer.baseUrl}/api/bot-thinking`, {
        headers: { Cookie: `${cookie}; ${cookie}` }
      });
      assert.strictEqual(duplicateCookie.status, 401);

      const malformedCookie = await fetch(`${firstServer.baseUrl}/api/bot-thinking`, {
        headers: { Cookie: 'mizuki_web_session=not-a-valid-session' }
      });
      assert.strictEqual(malformedCookie.status, 401);

      const logout = await fetch(`${firstServer.baseUrl}/api/session`, {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: firstServer.baseUrl }
      });
      assert.strictEqual(logout.status, 200);
      assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/i);

      const revoked = await fetch(`${firstServer.baseUrl}/api/bot-thinking`, {
        headers: { Cookie: cookie }
      });
      assert.strictEqual(revoked.status, 401);

      const restartLogin = await fetch(`${firstServer.baseUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: firstServer.baseUrl },
        body: JSON.stringify({ token: 'session-login-secret' })
      });
      assert.strictEqual(restartLogin.status, 201);
      restartCookie = (restartLogin.headers.get('set-cookie') || '').split(';', 1)[0];

      const wrongOne = await fetch(`${firstServer.baseUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: firstServer.baseUrl },
        body: JSON.stringify({ token: 'wrong-one' })
      });
      const wrongTwo = await fetch(`${firstServer.baseUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: firstServer.baseUrl },
        body: JSON.stringify({ token: 'wrong-two' })
      });
      const limited = await fetch(`${firstServer.baseUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: firstServer.baseUrl },
        body: JSON.stringify({ token: 'session-login-secret' })
      });
      assert.strictEqual(wrongOne.status, 401);
      assert.strictEqual(wrongTwo.status, 401);
      assert.strictEqual(limited.status, 429);
      assert.match(limited.headers.get('retry-after') || '', /^\d+$/);

    } finally {
      await firstServer.close();
      firstRuntime.sessionManager.stop();
    }

    const secondRuntime = createWebApp();
    const secondServer = await listen(secondRuntime.app);
    try {
      const restarted = await fetch(`${secondServer.baseUrl}/api/bot-thinking`, {
        headers: { Cookie: restartCookie }
      });
      assert.strictEqual(restarted.status, 401);
    } finally {
      await secondServer.close();
      secondRuntime.sessionManager.stop();
    }

    let expiryNow = 5000;
    const expiryManager = createWebSessionManager({
      maxSessions: 2,
      now: () => expiryNow,
      ttlMs: 60000
    });
    const expiryRuntime = createWebApp({
      sessionManager: expiryManager,
      loginRateLimiter: createLoginRateLimiter({ maxAttempts: 2, maxClients: 100, windowMs: 60000 })
    });
    const expiryServer = await listen(expiryRuntime.app);
    try {
      const login = await fetch(`${expiryServer.baseUrl}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: expiryServer.baseUrl },
        body: JSON.stringify({ token: 'session-login-secret' })
      });
      assert.strictEqual(login.status, 201);
      const cookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
      expiryNow += 60001;
      const expired = await fetch(`${expiryServer.baseUrl}/api/bot-thinking`, {
        headers: { Cookie: cookie }
      });
      assert.strictEqual(expired.status, 401);
    } finally {
      await expiryServer.close();
      expiryManager.stop();
    }
  });

  await withConfig({
    WEB_BIND_HOST: '0.0.0.0',
    WEB_REQUIRE_HTTPS: true,
    WEB_LOCAL_ONLY_WITHOUT_TOKEN: false,
    WEB_TOKEN: 'remote-web-secret',
    WEB_VIEWER_TOKEN: '',
    WEB_TRUST_PROXY_HOPS: 0,
    WEB_LOGIN_RATE_LIMIT_STATE_FILE: ''
  }, async () => {
    const runtime = createWebApp();
    const server = await listen(runtime.app);
    try {
      const health = await fetch(`${server.baseUrl}/healthz`);
      assert.strictEqual(health.status, 200);
      const login = await fetch(`${server.baseUrl}/login`);
      assert.strictEqual(login.status, 426);
    } finally {
      await server.close();
      runtime.sessionManager.stop();
    }
  });

  console.log('webSessionSecurity.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

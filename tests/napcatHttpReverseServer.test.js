const assert = require('assert');
const crypto = require('crypto');

function createSignature(secret, timestamp, nonce, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest('hex');
}

function createSignedHeaders(secret, timestamp, nonce, body) {
  return {
    'content-type': 'application/json',
    'x-napcat-timestamp': String(timestamp),
    'x-napcat-nonce': nonce,
    'x-napcat-signature': `sha256=${createSignature(secret, timestamp, nonce, body)}`
  };
}

function clearProjectCache() {
  const projectRoot = require('path').resolve(__dirname, '..') + require('path').sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.NAPCAT_HTTP_REVERSE_PORT = '0';
    process.env.NAPCAT_HTTP_REVERSE_BIND_HOST = '127.0.0.1';
    process.env.NAPCAT_HTTP_REVERSE_SECRET = 'reverse-test-secret';
    process.env.NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER = 'true';
    process.env.NAPCAT_HTTP_REVERSE_SIGNATURE_MAX_AGE_MS = '30000';
    clearProjectCache();

    const {
      createNapCatHttpReverseServer,
      startNapCatHttpReverseServer
    } = require('../core/napcatHttpReverseServer');
    const { patchOnebotConfig } = require('../scripts/configure-napcat-onebot');
    assert.throws(
      () => createNapCatHttpReverseServer({ secret: '' }),
      /NAPCAT_HTTP_REVERSE_SECRET is required/
    );
    const handled = [];
    const accepted = [];
    const server = startNapCatHttpReverseServer({
      acceptMessage(msg) {
        accepted.push(msg.message_id);
        if (msg.message_id === 2) throw new Error('simulated persistence failure');
        if (msg.message_id === 3) return { accepted: false, tracked: true };
        return { accepted: true, tracked: true };
      },
      handleMessage(msg, acceptance) {
        handled.push({ msg, acceptance });
      }
    });

    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.strictEqual(address.address, '127.0.0.1');

    const anonymousRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        user_id: 1960901788,
        message_id: 1,
        raw_message: '/restart confirm'
      })
    });
    assert.strictEqual(anonymousRes.status, 401);
    assert.strictEqual(handled.length, 0);

    const now = Date.now();
    const invalidBody = JSON.stringify({ post_type: 'message', message_id: 1 });
    const invalidSecretRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: createSignedHeaders('wrong-secret', now, 'invalid-secret-0001', invalidBody),
      body: invalidBody
    });
    assert.strictEqual(invalidSecretRes.status, 401);
    assert.strictEqual(handled.length, 0);

    const body = JSON.stringify({ post_type: 'message', message_id: 1 });
    const headers = createSignedHeaders('reverse-test-secret', now, 'accepted-nonce-0001', body);
    const res = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers,
      body
    });
    assert.strictEqual(res.status, 204);

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(handled.length, 1);
    assert.deepStrictEqual(accepted, [1]);
    assert.strictEqual(handled[0].msg.message_id, 1);
    assert.strictEqual(handled[0].acceptance.tracked, true);

    const persistenceFailureBody = JSON.stringify({ post_type: 'message', message_id: 2 });
    const persistenceFailureRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: createSignedHeaders('reverse-test-secret', now, 'persistence-fail01', persistenceFailureBody),
      body: persistenceFailureBody
    });
    assert.strictEqual(persistenceFailureRes.status, 503);

    const duplicateBody = JSON.stringify({ post_type: 'message', message_id: 3 });
    const duplicateRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: createSignedHeaders('reverse-test-secret', now, 'duplicate-message1', duplicateBody),
      body: duplicateBody
    });
    assert.strictEqual(duplicateRes.status, 204);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(handled.length, 1, 'declined duplicate must not be dispatched');

    const replayRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers,
      body
    });
    assert.strictEqual(replayRes.status, 409);

    const expiredTimestamp = now - 31000;
    const expiredRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: createSignedHeaders('reverse-test-secret', expiredTimestamp, 'expired-nonce-0001', body),
      body
    });
    assert.strictEqual(expiredRes.status, 401);

    const invalidPayload = JSON.stringify({ message_id: 2 });
    const invalidPayloadRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: createSignedHeaders('reverse-test-secret', now, 'invalid-payload-01', invalidPayload),
      body: invalidPayload
    });
    assert.strictEqual(invalidPayloadRes.status, 400);

    const malformedBody = '{"post_type":';
    const malformedRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: createSignedHeaders('reverse-test-secret', now, 'malformed-json-001', malformedBody),
      body: malformedBody
    });
    assert.strictEqual(malformedRes.status, 400);

    const nonJsonRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: {
        ...createSignedHeaders('reverse-test-secret', now, 'non-json-body-001', 'plain text'),
        'content-type': 'text/plain'
      },
      body: 'plain text'
    });
    assert.strictEqual(nonJsonRes.status, 415);

    const generatedNapCatConfig = patchOnebotConfig({ network: {} });
    const generatedReverseToken = generatedNapCatConfig.network.httpClients[0].token;
    assert.strictEqual(generatedReverseToken, 'reverse-test-secret');
    const legacyRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${generatedReverseToken}`
      },
      body: JSON.stringify({ post_type: 'notice' })
    });
    assert.strictEqual(legacyRes.status, 204);

    const oneBotBody = JSON.stringify({ post_type: 'notice', notice_type: 'onebot-signature' });
    const oneBotSignature = crypto
      .createHmac('sha1', generatedReverseToken)
      .update(oneBotBody)
      .digest('hex');
    const oneBotRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': `sha1=${oneBotSignature}`
      },
      body: oneBotBody
    });
    assert.strictEqual(oneBotRes.status, 204);

    const invalidOneBotRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': `sha1=${'0'.repeat(40)}`
      },
      body: oneBotBody
    });
    assert.strictEqual(invalidOneBotRes.status, 401);

    const signedOnlyApp = createNapCatHttpReverseServer({
      secret: 'reverse-test-secret',
      allowLegacyBearer: false
    });
    const signedOnlyServer = signedOnlyApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => signedOnlyServer.once('listening', resolve));
    const signedOnlyAddress = signedOnlyServer.address();
    const signedOnlyBody = JSON.stringify({ post_type: 'notice', notice_type: 'signed-only' });
    const signedOnlySignature = crypto
      .createHmac('sha1', 'reverse-test-secret')
      .update(signedOnlyBody)
      .digest('hex');
    const signedOnlyRes = await fetch(`http://127.0.0.1:${signedOnlyAddress.port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': `sha1=${signedOnlySignature}`
      },
      body: signedOnlyBody
    });
    assert.strictEqual(signedOnlyRes.status, 204);
    const disabledBearerRes = await fetch(`http://127.0.0.1:${signedOnlyAddress.port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer reverse-test-secret'
      },
      body: signedOnlyBody
    });
    assert.strictEqual(disabledBearerRes.status, 401);
    await new Promise((resolve, reject) => {
      signedOnlyServer.close((error) => (error ? reject(error) : resolve()));
    });

    const limitedApp = createNapCatHttpReverseServer({
      secret: 'reverse-test-secret',
      rateLimitMax: 1,
      rateLimitWindowMs: 60000
    });
    const limitedServer = limitedApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => limitedServer.once('listening', resolve));
    const limitedAddress = limitedServer.address();
    const limitedBody = JSON.stringify({ post_type: 'message', message_id: 3 });
    const rejectedLimitedRes = await fetch(`http://127.0.0.1:${limitedAddress.port}/`, {
      method: 'POST',
      headers: createSignedHeaders('wrong-secret', now, 'rejected-limit-01', limitedBody),
      body: limitedBody
    });
    assert.strictEqual(rejectedLimitedRes.status, 401);
    const firstLimitedRes = await fetch(`http://127.0.0.1:${limitedAddress.port}/`, {
      method: 'POST',
      headers: createSignedHeaders('reverse-test-secret', now, 'rate-limit-nonce1', limitedBody),
      body: limitedBody
    });
    assert.strictEqual(firstLimitedRes.status, 204);
    const secondLimitedRes = await fetch(`http://127.0.0.1:${limitedAddress.port}/`, {
      method: 'POST',
      headers: createSignedHeaders('reverse-test-secret', now, 'rate-limit-nonce2', limitedBody),
      body: limitedBody
    });
    assert.strictEqual(secondLimitedRes.status, 429);
    assert.ok(secondLimitedRes.headers.get('retry-after'));
    await new Promise((resolve, reject) => {
      limitedServer.close((error) => (error ? reject(error) : resolve()));
    });

    const proxiedApp = createNapCatHttpReverseServer({
      secret: 'reverse-test-secret',
      rateLimitMax: 1,
      rateLimitWindowMs: 60000,
      trustProxy: 'loopback'
    });
    const proxiedServer = proxiedApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => proxiedServer.once('listening', resolve));
    const proxiedAddress = proxiedServer.address();
    for (const [index, forwardedFor] of ['192.0.2.10', '192.0.2.11'].entries()) {
      const proxiedBody = JSON.stringify({ post_type: 'notice', notice_type: 'test' });
      const proxiedRes = await fetch(`http://127.0.0.1:${proxiedAddress.port}/`, {
        method: 'POST',
        headers: {
          ...createSignedHeaders('reverse-test-secret', now, `proxy-client-000${index}`, proxiedBody),
          'x-forwarded-for': forwardedFor
        },
        body: proxiedBody
      });
      assert.strictEqual(proxiedRes.status, 204);
    }
    await new Promise((resolve, reject) => {
      proxiedServer.close((error) => (error ? reject(error) : resolve()));
    });

    const sizeLimitedApp = createNapCatHttpReverseServer({
      secret: 'reverse-test-secret',
      maxBodyBytes: 1024
    });
    const sizeLimitedServer = sizeLimitedApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => sizeLimitedServer.once('listening', resolve));
    const sizeLimitedAddress = sizeLimitedServer.address();
    const oversizedBody = JSON.stringify({ post_type: 'message', raw_message: 'x'.repeat(1100) });
    const oversizedRes = await fetch(`http://127.0.0.1:${sizeLimitedAddress.port}/`, {
      method: 'POST',
      headers: createSignedHeaders('reverse-test-secret', now, 'oversized-body-001', oversizedBody),
      body: oversizedBody
    });
    assert.strictEqual(oversizedRes.status, 413);
    await new Promise((resolve, reject) => {
      sizeLimitedServer.close((error) => (error ? reject(error) : resolve()));
    });

    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    console.log('napcatHttpReverseServer.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

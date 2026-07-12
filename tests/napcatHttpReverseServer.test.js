const assert = require('assert');

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
    clearProjectCache();

    const {
      createNapCatHttpReverseServer,
      startNapCatHttpReverseServer
    } = require('../core/napcatHttpReverseServer');
    assert.throws(
      () => createNapCatHttpReverseServer({ secret: '' }),
      /NAPCAT_HTTP_REVERSE_SECRET is required/
    );
    const handled = [];
    const server = startNapCatHttpReverseServer({
      handleMessage(msg) {
        handled.push(msg);
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

    const invalidSecretRes = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-secret'
      },
      body: JSON.stringify({ post_type: 'message', message_id: 1 })
    });
    assert.strictEqual(invalidSecretRes.status, 401);
    assert.strictEqual(handled.length, 0);

    const res = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer reverse-test-secret'
      },
      body: JSON.stringify({ post_type: 'message', message_id: 1 })
    });
    assert.strictEqual(res.status, 204);

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(handled.length, 1);
    assert.strictEqual(handled[0].message_id, 1);

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

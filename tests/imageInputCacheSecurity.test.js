const assert = require('assert');

const { ensureCachedImageRef } = require('../utils/imageInputCache');

(async () => {
  let requestCalled = false;
  const privateResult = await ensureCachedImageRef('https://image.test/private.png', {
    lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    request: async () => {
      requestCalled = true;
      return { status: 200, headers: {}, data: Buffer.from('unsafe') };
    }
  });
  assert.strictEqual(privateResult.ok, false);
  assert.match(privateResult.reason, /disallowed/);
  assert.strictEqual(requestCalled, false);

  const redirectResult = await ensureCachedImageRef('https://image.test/start.png', {
    lookup: async (hostname) => hostname === 'image.test'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '10.0.0.8', family: 4 }],
    request: async () => ({
      status: 302,
      headers: { location: 'http://internal.test/image.png' }
    })
  });
  assert.strictEqual(redirectResult.ok, false);
  assert.match(redirectResult.reason, /disallowed/);

  const oversizedResult = await ensureCachedImageRef('https://image.test/large.png', {
    maxBytes: 1024,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({
      status: 200,
      headers: { 'content-type': 'image/png' },
      data: Buffer.alloc(1025)
    })
  });
  assert.strictEqual(oversizedResult.ok, false);
  assert.match(oversizedResult.reason, /exceeds 1024 byte limit/);

  console.log('imageInputCacheSecurity.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

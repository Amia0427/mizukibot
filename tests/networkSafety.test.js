const assert = require('assert');

const {
  assertSafeHttpUrl,
  assertSafeModelEndpoint,
  isUnsafeHttpUrl
} = require('../utils/networkSafety');

async function assertRejectsUnsafe(url, lookupAddress) {
  let called = false;
  await assert.rejects(
    () => assertSafeHttpUrl(url, {
      lookup: async () => {
        called = true;
        return [{ address: lookupAddress || '93.184.216.34', family: 4 }];
      }
    }),
    /not allowed|disallowed|http or https|resolved/
  );
  return called;
}

(async () => {
  assert.strictEqual(isUnsafeHttpUrl('http://127.0.0.1:3000/x'), true);
  assert.strictEqual(isUnsafeHttpUrl('http://localhost/x'), true);
  assert.strictEqual(isUnsafeHttpUrl('http://169.254.169.254/latest/meta-data'), true);
  assert.strictEqual(isUnsafeHttpUrl('http://100.100.100.200/latest/meta-data'), true);
  assert.strictEqual(isUnsafeHttpUrl('http://metadata.google.internal/'), true);
  assert.strictEqual(isUnsafeHttpUrl('http://10.0.0.1/x'), true);
  assert.strictEqual(isUnsafeHttpUrl('http://172.16.0.1/x'), true);
  assert.strictEqual(isUnsafeHttpUrl('http://192.168.1.1/x'), true);
  assert.strictEqual(isUnsafeHttpUrl('https://example.com/image.png'), false);

  assert.strictEqual(await assertRejectsUnsafe('http://127.0.0.1:3000/x'), false);
  assert.strictEqual(await assertRejectsUnsafe('http://metadata.google.internal/'), false);
  assert.strictEqual(await assertRejectsUnsafe('file:///tmp/image.png'), false);
  assert.strictEqual(await assertRejectsUnsafe('https://example.com/image.png', '10.0.0.1'), true);
  assert.strictEqual(await assertRejectsUnsafe('https://example.com/image.png', '169.254.169.254'), true);

  const parsed = await assertSafeHttpUrl('https://example.com/image.png', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  assert.strictEqual(parsed.hostname, 'example.com');

  await assert.rejects(
    () => assertSafeModelEndpoint('http://example.com/v1/chat/completions', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }]
    }),
    /https/
  );
  await assert.rejects(
    () => assertSafeModelEndpoint('https://example.com/v1/chat/completions', {
      lookup: async () => [{ address: '192.168.1.2', family: 4 }]
    }),
    /disallowed/
  );
  const localEndpoint = await assertSafeModelEndpoint('http://127.0.0.1:11434/v1/chat/completions', { allowLocalHttp: true });
  assert.strictEqual(localEndpoint.hostname, '127.0.0.1');

  console.log('networkSafety.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

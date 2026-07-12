const assert = require('assert');

const { summarizeInput } = require('../api/skills_native/summarize');

(async () => {
  let requestCalled = false;
  const privateResult = await summarizeInput({ input: 'https://page.test/private' }, __dirname, {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    request: async () => {
      requestCalled = true;
      return { status: 200, headers: {}, data: 'unsafe' };
    }
  });
  assert.match(privateResult, /总结失败：.*disallowed/);
  assert.strictEqual(requestCalled, false);

  const redirectResult = await summarizeInput({ input: 'https://page.test/start' }, __dirname, {
    lookup: async (hostname) => hostname === 'page.test'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '192.168.1.8', family: 4 }],
    request: async () => ({
      status: 302,
      headers: { location: 'http://internal.test/secret' }
    })
  });
  assert.match(redirectResult, /总结失败：.*disallowed/);

  const oversizedResult = await summarizeInput({ input: 'https://page.test/large' }, __dirname, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({
      status: 200,
      headers: {},
      data: 'x'.repeat(2 * 1024 * 1024 + 1)
    })
  });
  assert.match(oversizedResult, /总结失败：.*exceeds .* byte limit/);

  console.log('nativeSummarizeSecurity.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

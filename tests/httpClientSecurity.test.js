const assert = require('assert');
const axios = require('axios');

const {
  mapMessagesToAnthropic,
  postStreamWithRetry,
  postWithRetry
} = require('../api/httpClient');

async function withAxiosGetStub(stub, fn) {
  const original = axios.get;
  axios.get = stub;
  try {
    await fn();
  } finally {
    axios.get = original;
  }
}

async function withAxiosPostStub(stub, fn) {
  const original = axios.post;
  axios.post = stub;
  try {
    await fn();
  } finally {
    axios.post = original;
  }
}

(async () => {
  await withAxiosGetStub(async () => {
    throw new Error('axios.get should not be called when anthropic can consume image URLs directly');
  }, async () => {
    const mapped = await mapMessagesToAnthropic([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }
        ]
      }
    ]);
    const image = mapped.messages[0].content[0];
    assert.strictEqual(image.type, 'image');
    assert.strictEqual(image.source.type, 'url');
    assert.strictEqual(image.source.url, 'https://example.com/image.png');
    assert.ok(!Object.prototype.hasOwnProperty.call(image.source, 'data'));
  });

  await withAxiosGetStub(async () => {
    throw new Error('axios.get should not be called for unsafe image URLs');
  }, async () => {
    const mapped = await mapMessagesToAnthropic([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'http://127.0.0.1/image.png' } }
        ]
      }
    ]);
    const block = mapped.messages[0].content[0];
    assert.strictEqual(block.type, 'text');
    assert.match(block.text, /\[Image URL\] http:\/\/127\.0\.0\.1\/image\.png/);
  });

  await withAxiosPostStub(async () => {
    throw new Error('axios.post should not be called for unsafe model endpoints');
  }, async () => {
    await assert.rejects(
      () => postWithRetry('http://127.0.0.1:11434/v1/chat/completions', { model: 'test', messages: [] }, 0),
      /not allowed|https|disallowed/
    );
    await assert.rejects(
      () => postStreamWithRetry('http://169.254.169.254/v1/chat/completions', { model: 'test', messages: [] }, {}, 0),
      /not allowed|https|disallowed/
    );
  });

  console.log('httpClientSecurity.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

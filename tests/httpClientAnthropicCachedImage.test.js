const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-anthropic-image-'));

  try {
    process.env.DATA_DIR = tempDataDir;
    const httpClient = require('../api/httpClient');

    const cacheDir = path.join(tempDataDir, 'inbound_image_cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'anth-cache.json'), JSON.stringify({
      cacheKey: 'anth-cache',
      sourceUrl: 'https://example.com/anthropic.png',
      mediaType: 'image/png'
    }), 'utf8');
    fs.writeFileSync(path.join(cacheDir, 'anth-cache.bin'), Buffer.from('anthropic-image-binary'));

    const prepared = await httpClient.prepareRequest('https://example.com/v1/messages', {
      model: 'claude-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'cached-image://anth-cache' } }
          ]
        }
      ],
      stream: false
    });

    assert.strictEqual(prepared.provider, 'anthropic');
    assert.strictEqual(prepared.requestUrl, 'https://example.com/v1/messages');
    const content = prepared.requestBody.messages[0].content;
    assert.strictEqual(content[1].type, 'image');
    assert.strictEqual(content[1].source.media_type, 'image/png');
    assert.strictEqual(content[1].source.type, 'base64');
    assert.ok(String(content[1].source.data || '').length > 0);

    console.log('httpClientAnthropicCachedImage.test.js passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

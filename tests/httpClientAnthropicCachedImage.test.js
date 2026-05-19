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

    assert.strictEqual(prepared.provider, 'openai_compatible');
    assert.strictEqual(prepared.requestUrl, 'https://example.com/v1/responses');
    const content = prepared.requestBody.input[0].content;
    assert.strictEqual(content[1].type, 'input_image');
    assert.ok(/^data:image\/png;base64,/i.test(String(content[1].image_url || '')));

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

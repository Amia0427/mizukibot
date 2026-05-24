const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-anthropic-image-'));

  try {
    process.env.DATA_DIR = tempDataDir;
    process.env.ANTHROPIC_INLINE_IMAGE_MAX_BASE64_CHARS = '120000';
    process.env.ANTHROPIC_DOWNSAMPLED_IMAGE_MAX_EDGE = '256';
    clearProjectCache();
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

    const largePayload = Buffer.alloc(92000, 1);
    fs.writeFileSync(path.join(cacheDir, 'anth-large-url.json'), JSON.stringify({
      cacheKey: 'anth-large-url',
      sourceUrl: 'https://example.com/large.png',
      mediaType: 'image/png'
    }), 'utf8');
    fs.writeFileSync(path.join(cacheDir, 'anth-large-url.bin'), largePayload);

    const preparedLargeUrl = await httpClient.prepareRequest('https://example.com/v1/messages', {
      model: 'claude-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看大图' },
            { type: 'image_url', image_url: { url: 'cached-image://anth-large-url' } }
          ]
        }
      ],
      stream: false
    });

    const largeUrlBlock = preparedLargeUrl.requestBody.messages[0].content[1];
    assert.strictEqual(largeUrlBlock.type, 'image');
    assert.strictEqual(largeUrlBlock.source.type, 'url');
    assert.strictEqual(largeUrlBlock.source.url, 'https://example.com/large.png');

    fs.writeFileSync(path.join(cacheDir, 'anth-large-local.json'), JSON.stringify({
      cacheKey: 'anth-large-local',
      sourceUrl: '',
      mediaType: 'image/png'
    }), 'utf8');
    fs.writeFileSync(path.join(cacheDir, 'anth-large-local.bin'), largePayload);

    const preparedLargeLocal = await httpClient.prepareRequest('https://example.com/v1/messages', {
      model: 'claude-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看本地大图' },
            { type: 'image_url', image_url: { url: 'cached-image://anth-large-local' } }
          ]
        }
      ],
      stream: false
    });

    const largeLocalBlock = preparedLargeLocal.requestBody.messages[0].content[1];
    assert.strictEqual(largeLocalBlock.type, 'text');
    assert.match(largeLocalBlock.text, /too large to inline safely/);
    assert.ok(!JSON.stringify(preparedLargeLocal.requestBody).includes(largePayload.toString('base64')));

    const sharp = require('sharp');
    const qqSourceUrl = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=oversized';
    const oversizedRaw = Buffer.alloc(1254 * 1254 * 3);
    for (let i = 0; i < oversizedRaw.length; i += 3) {
      const pixel = i / 3;
      const x = pixel % 1254;
      const y = Math.floor(pixel / 1254);
      oversizedRaw[i] = (x * 17 + y * 3) % 256;
      oversizedRaw[i + 1] = (x * 5 + y * 19) % 256;
      oversizedRaw[i + 2] = (x * 11 + y * 7) % 256;
    }
    const oversizedPng = await sharp(oversizedRaw, {
      raw: {
        width: 1254,
        height: 1254,
        channels: 3
      }
    })
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(cacheDir, 'anth-large-qq.json'), JSON.stringify({
      cacheKey: 'anth-large-qq',
      sourceUrl: qqSourceUrl,
      mediaType: 'image/png'
    }), 'utf8');
    fs.writeFileSync(path.join(cacheDir, 'anth-large-qq.bin'), oversizedPng);

    const preparedLargeQq = await httpClient.prepareRequest('https://example.com/v1/messages', {
      model: 'claude-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看 QQ 大图' },
            { type: 'image_url', image_url: { url: 'cached-image://anth-large-qq' } }
          ]
        }
      ],
      stream: false
    });

    const largeQqBlock = preparedLargeQq.requestBody.messages[0].content[1];
    assert.strictEqual(largeQqBlock.type, 'image');
    assert.strictEqual(largeQqBlock.source.type, 'base64');
    assert.strictEqual(largeQqBlock.source.media_type, 'image/jpeg');
    assert.ok(largeQqBlock.source.data.length <= 120000);
    assert.ok(!Object.prototype.hasOwnProperty.call(largeQqBlock.source, 'url'));
    assert.ok(!JSON.stringify(preparedLargeQq.requestBody).includes(oversizedPng.toString('base64')));

    console.log('httpClientAnthropicCachedImage.test.js passed');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      process.env[key] = value;
    }
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

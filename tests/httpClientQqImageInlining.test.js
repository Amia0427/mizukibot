const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = (async () => {
  const originalAxios = require('axios');
  const originalPost = originalAxios.post;
  const originalGet = originalAxios.get;
  const snapshot = { ...process.env };
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-httpclient-image-'));

  let capturedBody = null;
  const gifBuffer = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');

  try {
    process.env.DATA_DIR = tempDataDir;
    process.env.OPENAI_MAIN_API_MODE = 'chat_completions';
    const httpClient = require('../api/httpClient');
    originalAxios.get = async (url) => String(url).includes('animation.gif')
      ? {
          headers: { 'content-type': 'image/gif' },
          data: gifBuffer
        }
      : {
          headers: { 'content-type': 'image/png' },
          data: Buffer.from('fake-image-binary')
        };

    originalAxios.post = async (_url, body) => {
      capturedBody = body;
      return {
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok'
              }
            }
          ]
        }
      };
    };

    await httpClient.postWithRetry('https://example.com/v1/chat/completions', {
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看看这张图' },
            { type: 'image_url', image_url: { url: 'https://multimedia.nt.qq.com.cn/test-image', detail: '' } }
          ]
        }
      ],
      stream: false
    }, 0, 'test-key');

    assert.ok(capturedBody);
    const imagePart = capturedBody.messages[0].content[1];
    assert.strictEqual(imagePart.type, 'image_url');
    assert.ok(/^data:image\/png;base64,/i.test(String(imagePart.image_url?.url || '')));
    assert.ok(!Object.prototype.hasOwnProperty.call(imagePart.image_url || {}, 'detail'));

    await httpClient.postWithRetry('https://example.com/v1/chat/completions', {
      model: 'gcli-gemini-3-flash-preview-nothinking',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '远程 GIF 也要转成模型可接受的图片' },
            { type: 'image_url', image_url: { url: 'https://multimedia.nt.qq.com.cn/animation.gif' } }
          ]
        }
      ],
      stream: false
    }, 0, 'test-key');

    const remoteGifImagePart = capturedBody.messages[0].content[1];
    assert.ok(/^data:image\/jpeg;base64,/i.test(String(remoteGifImagePart.image_url?.url || '')));
    assert.strictEqual(Buffer.from(String(remoteGifImagePart.image_url?.url).split(',')[1], 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');

    await httpClient.postWithRetry('https://example.com/v1/chat/completions', {
      model: 'gcli-gemini-3-flash-preview-nothinking',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '内联 GIF 也要转成模型可接受的图片' },
            { type: 'image_url', image_url: { url: `data:image/gif;base64,${gifBuffer.toString('base64')}` } }
          ]
        }
      ],
      stream: false
    }, 0, 'test-key');

    const inlineGifImagePart = capturedBody.messages[0].content[1];
    assert.ok(/^data:image\/jpeg;base64,/i.test(String(inlineGifImagePart.image_url?.url || '')));
    assert.strictEqual(Buffer.from(String(inlineGifImagePart.image_url?.url).split(',')[1], 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');

    await httpClient.postWithRetry('https://example.com/v1/chat/completions', {
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '保留合法 detail' },
            { type: 'image_url', image_url: { url: 'https://multimedia.nt.qq.com.cn/test-image-2', detail: 'low' } }
          ]
        }
      ],
      stream: false
    }, 0, 'test-key');

    const secondImagePart = capturedBody.messages[0].content[1];
    assert.strictEqual(secondImagePart.image_url?.detail, 'low');

    const cacheDir = path.join(tempDataDir, 'inbound_image_cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'cached-ref.json'), JSON.stringify({
      cacheKey: 'cached-ref',
      sourceUrl: 'https://example.com/from-cache.png',
      mediaType: 'image/png'
    }), 'utf8');
    fs.writeFileSync(path.join(cacheDir, 'cached-ref.bin'), Buffer.from('cached-image-binary'));
    fs.writeFileSync(path.join(cacheDir, 'cached-gif-ref.json'), JSON.stringify({
      cacheKey: 'cached-gif-ref',
      sourceUrl: 'https://example.com/animation.gif',
      mediaType: 'image/gif'
    }), 'utf8');
    fs.writeFileSync(path.join(cacheDir, 'cached-gif-ref.bin'), gifBuffer);

    await httpClient.postWithRetry('https://example.com/v1/chat/completions', {
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '缓存引用命中后也要内联' },
            { type: 'image_url', image_url: { url: 'cached-image://cached-ref' } }
          ]
        }
      ],
      stream: false
    }, 0, 'test-key');

    const cachedHitImagePart = capturedBody.messages[0].content[1];
    assert.strictEqual(cachedHitImagePart.type, 'image_url');
    assert.ok(/^data:image\/png;base64,/i.test(String(cachedHitImagePart.image_url?.url || '')));

    await httpClient.postWithRetry('https://example.com/v1/chat/completions', {
      model: 'gcli-gemini-3-flash-preview-nothinking',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '缓存 GIF 也要转成模型可接受的图片' },
            { type: 'image_url', image_url: { url: 'cached-image://cached-gif-ref' } }
          ]
        }
      ],
      stream: false
    }, 0, 'test-key');

    const cachedGifImagePart = capturedBody.messages[0].content[1];
    assert.ok(/^data:image\/jpeg;base64,/i.test(String(cachedGifImagePart.image_url?.url || '')));
    assert.strictEqual(Buffer.from(String(cachedGifImagePart.image_url?.url).split(',')[1], 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');
    assert.deepStrictEqual(fs.readFileSync(path.join(cacheDir, 'cached-gif-ref.bin')), gifBuffer);

    fs.rmSync(path.join(cacheDir, 'cached-ref.bin'));

    await httpClient.postWithRetry('https://example.com/v1/chat/completions', {
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '缓存引用也要内联' },
            { type: 'image_url', image_url: { url: 'cached-image://cached-ref' } }
          ]
        }
      ],
      stream: false
    }, 0, 'test-key');

    const cachedImagePart = capturedBody.messages[0].content[1];
    assert.strictEqual(cachedImagePart.type, 'text');
    assert.strictEqual(cachedImagePart.text, '[Image unavailable: cached image payload missing.]');

    console.log('httpClientQqImageInlining.test.js passed');
  } finally {
    originalAxios.post = originalPost;
    originalAxios.get = originalGet;
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

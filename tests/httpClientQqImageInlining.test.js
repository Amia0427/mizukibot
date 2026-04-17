const assert = require('assert');

const httpClient = require('../api/httpClient');

module.exports = (async () => {
  const originalAxios = require('axios');
  const originalPost = originalAxios.post;
  const originalGet = originalAxios.get;

  let capturedBody = null;

  try {
    originalAxios.get = async () => ({
      headers: { 'content-type': 'image/png' },
      data: Buffer.from('fake-image-binary')
    });

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
            { type: 'image_url', image_url: { url: 'https://multimedia.nt.qq.com.cn/test-image' } }
          ]
        }
      ],
      stream: false
    }, 0, 'test-key');

    assert.ok(capturedBody);
    const imagePart = capturedBody.messages[0].content[1];
    assert.strictEqual(imagePart.type, 'image_url');
    assert.ok(/^data:image\/png;base64,/i.test(String(imagePart.image_url?.url || '')));

    console.log('httpClientQqImageInlining.test.js passed');
  } finally {
    originalAxios.post = originalPost;
    originalAxios.get = originalGet;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

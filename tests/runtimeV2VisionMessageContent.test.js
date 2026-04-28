const assert = require('assert');

const { buildVisionMessageContent } = require('../api/runtimeV2/context/service');

module.exports = (async () => {
  const content = buildVisionMessageContent('对比这两张', 'https://example.com/a.png', [
    'https://example.com/a.png',
    'https://example.com/b.png'
  ]);

  assert.ok(Array.isArray(content), 'vision message content should be multi-part');
  assert.strictEqual(content[0].type, 'text');
  assert.deepStrictEqual(
    content
      .filter((part) => part.type === 'image_url')
      .map((part) => part.image_url.url),
    [
      'https://example.com/a.png',
      'https://example.com/b.png'
    ]
  );

  console.log('runtimeV2VisionMessageContent.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

const assert = require('assert');

const config = require('../config');
const { buildVisionMessageContent } = require('../api/runtimeV2/context/service');

module.exports = (async () => {
  function textFor(question, imageUrl = 'https://example.com/a.png', imageUrls = []) {
    const content = buildVisionMessageContent(question, imageUrl, imageUrls);
    assert.ok(Array.isArray(content), 'vision message content should be multi-part');
    assert.strictEqual(content[0].type, 'text');
    return content[0].text;
  }

  const noImageContent = buildVisionMessageContent('只是一句文字', null, []);
  assert.strictEqual(noImageContent, '只是一句文字');

  const content = buildVisionMessageContent('对比这两张', 'https://example.com/a.png', [
    'https://example.com/a.png',
    'https://example.com/b.png'
  ]);

  assert.ok(Array.isArray(content), 'vision message content should be multi-part');
  assert.strictEqual(content[0].type, 'text');
  assert.strictEqual(content[0].text, '用户原文：对比这两张\n\n图片数量：2');
  assert.ok(!content[0].text.includes('用户图片意图'));
  assert.ok(!content[0].text.includes('图片聊天语用规则'));
  assert.ok(!content[0].text.includes('VisionCaptionJSON'));
  assert.deepStrictEqual(
    content
      .filter((part) => part.type === 'image_url')
      .map((part) => part.image_url.url),
    [
      'https://example.com/a.png',
      'https://example.com/b.png'
    ]
  );

  assert.strictEqual(textFor(''), '用户原文：用户仅发送了图片。\n\n图片数量：1');
  assert.strictEqual(textFor('哈哈哈'), '用户原文：哈哈哈\n\n图片数量：1');
  assert.strictEqual(textFor('这图什么意思'), '用户原文：这图什么意思\n\n图片数量：1');
  assert.strictEqual(textFor('识别一下文字'), '用户原文：识别一下文字\n\n图片数量：1');

  config.VISION_ROUTE_USER_TEXT_MAX_TOKENS = 64;
  const repeatedContext = '很长的引用内容';
  const longQuestion = `BEGIN_QUOTE ${repeatedContext.repeat(120)}\n真正的问题：总结这张图`;
  const truncated = textFor(longQuestion);
  assert.ok(truncated.includes('真正的问题：总结这张图'), 'vision prompt should keep the tail user instruction');
  assert.ok(!truncated.includes('BEGIN_QUOTE'), 'vision prompt should trim oversized quoted/raw text');
  const remainingRepeatedContextCount = (truncated.match(new RegExp(repeatedContext, 'g')) || []).length;
  assert.ok(remainingRepeatedContextCount < 120, 'vision prompt should trim repeated oversized context');

  console.log('runtimeV2VisionMessageContent.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

const assert = require('assert');

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
  assert.ok(content[0].text.includes('用户原文：对比这两张'));
  assert.ok(content[0].text.includes('图片数量：2'));
  assert.ok(content[0].text.includes('用户图片意图：analyze_image'));
  assert.ok(content[0].text.includes('表情包、贴纸、梗图、反应图'));
  assert.ok(content[0].text.includes('适用于 meme_reaction'));
  assert.ok(content[0].text.includes('适用于 explain_image'));
  assert.ok(content[0].text.includes('适用于 analyze_image'));
  assert.ok(content[0].text.includes('接梗反应'));
  assert.ok(content[0].text.includes('简短解释'));
  assert.ok(content[0].text.includes('认真分析'));
  assert.ok(content[0].text.includes('只回 1-2 句'));
  assert.ok(content[0].text.includes('不确定梗或来源时可以说“我感觉你是在表达……'));
  assert.ok(content[0].text.includes('认真看图并回答问题，不要硬接梗'));
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

  assert.ok(textFor('').includes('用户图片意图：meme_reaction'));
  assert.ok(textFor('哈哈哈').includes('用户图片意图：meme_reaction'));
  assert.ok(textFor('绷不住了').includes('用户图片意图：meme_reaction'));
  assert.ok(textFor('这图什么意思').includes('用户图片意图：explain_image'));
  assert.ok(textFor('啥梗').includes('用户图片意图：explain_image'));
  assert.ok(textFor('帮我看哪里错了').includes('用户图片意图：analyze_image'));
  assert.ok(textFor('图里写了啥').includes('用户图片意图：analyze_image'));
  assert.ok(textFor('识别一下文字').includes('用户图片意图：analyze_image'));

  console.log('runtimeV2VisionMessageContent.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

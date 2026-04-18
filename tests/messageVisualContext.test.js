const assert = require('assert');

const {
  buildDirectedConversationSummary,
  buildVisualImageCollection,
  createMessageVisualContext,
  resolveVisualInputFromContinuousMetaCore
} = require('../core/messageVisualContext');

const history = {
  'qq-group:g1:user:u1': [
    { role: 'user', content: '前面我们在聊测试重构' },
    { role: 'assistant', content: '好的，我继续拆模块。' }
  ]
};

const visualContext = createMessageVisualContext({
  chatHistory: history
});

const summary = buildDirectedConversationSummary({
  scene: 'reply',
  addressee: { senderName: 'Alice' },
  quote: { senderName: 'Bob', text: '看看这张图', hasImage: true }
});

assert.ok(summary.includes('Scene: reply'));
assert.ok(summary.includes('Current message to: Alice'));
assert.ok(summary.includes('Quoted message from: Bob'));

const subagentSummary = visualContext.buildSubagentContextSummary('u1', 'g1');
assert.ok(subagentSummary.includes('Previous user: 前面我们在聊测试重构'));
assert.ok(subagentSummary.includes('Previous assistant: 好的，我继续拆模块。'));

const selected = resolveVisualInputFromContinuousMetaCore({
  selectedImageUrl: 'https://example.com/current.png',
  replyContext: { imageUrls: ['https://example.com/reply.png'] }
}, null, '看我这张图');
assert.strictEqual(selected, 'https://example.com/current.png');

const quoted = resolveVisualInputFromContinuousMetaCore({
  selectedImageUrl: 'https://example.com/current.png',
  replyContext: { imageUrls: ['https://example.com/reply.png'] }
}, {
  quotePriority: {
    enabled: true,
    mode: 'anchored_rewrite',
    quoteFocus: { hasImage: true }
  }
}, '引用那张图');
assert.strictEqual(quoted, 'https://example.com/reply.png');

const collectedReplyFirst = buildVisualImageCollection({
  imageUrls: ['https://example.com/current-a.png', 'https://example.com/shared.png'],
  replyContext: { imageUrls: ['https://example.com/reply-a.png', 'https://example.com/shared.png'] },
  forwardImageUrls: ['https://example.com/forward-a.png']
}, {
  quotePriority: {
    enabled: true,
    mode: 'anchored_rewrite',
    quoteFocus: { hasImage: true }
  }
}, '引用那张图', { maxImages: 8 });

assert.deepStrictEqual(
  collectedReplyFirst.map((item) => ({ source: item.source, url: item.url })),
  [
    { source: 'reply', url: 'https://example.com/reply-a.png' },
    { source: 'reply', url: 'https://example.com/shared.png' },
    { source: 'current', url: 'https://example.com/current-a.png' },
    { source: 'forward', url: 'https://example.com/forward-a.png' }
  ]
);

const collectedCurrentFirst = buildVisualImageCollection({
  imageUrls: ['https://example.com/current-a.png'],
  replyContext: { imageUrls: ['https://example.com/reply-a.png'] },
  forwardImageUrls: ['https://example.com/forward-a.png']
}, null, '看我这张图', { maxImages: 2 });

assert.deepStrictEqual(
  collectedCurrentFirst.map((item) => ({ source: item.source, url: item.url })),
  [
    { source: 'current', url: 'https://example.com/current-a.png' },
    { source: 'reply', url: 'https://example.com/reply-a.png' }
  ]
);

console.log('messageVisualContext.test.js passed');

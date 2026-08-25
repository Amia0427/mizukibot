const assert = require('assert');

const {
  FALLBACKS,
  createCompanionRoomModelClient,
  protectCompanionMessage
} = require('../src/features/companion-room/model');

assert.strictEqual(protectCompanionMessage('', 'midpoint'), FALLBACKS.midpoint);
assert.strictEqual(protectCompanionMessage('[CQ:image,file=test]', 'closing'), FALLBACKS.closing);
assert.strictEqual(protectCompanionMessage('https://example.com', 'summary'), FALLBACKS.summary);
assert.strictEqual(protectCompanionMessage('**我还在这里陪你。**', 'midpoint'), FALLBACKS.midpoint);
assert.strictEqual(protectCompanionMessage('我把杯子里的水喝完啦，还在这里陪你。', 'midpoint'), '我把杯子里的水喝完啦，还在这里陪你。');

module.exports = (async () => {
  let capturedOptions = null;
  let capturedMessages = null;
  const generate = createCompanionRoomModelClient({
    async requestAssistantMessage(messages, options) {
      capturedMessages = messages;
      capturedOptions = options;
      return { content: '我也刚把手边的一小段整理好。' };
    }
  });
  assert.strictEqual(await generate({
    phase: 'midpoint',
    userId: 'user-1',
    room: { activityType: 'focus', contentType: 'read', contentTitle: '三体', contentProgress: '第 3 章' }
  }), '我也刚把手边的一小段整理好。');
  assert.strictEqual(capturedOptions.disableTools, true);
  assert.deepStrictEqual(capturedOptions.allowedTools, []);
  assert.ok(capturedMessages[0].content.includes('不要声称你实际读取、观看或播放了媒体'));
  assert.ok(capturedMessages[1].content.includes('三体'));
  assert.ok(capturedMessages[1].content.includes('第 3 章'));

  const fallback = createCompanionRoomModelClient({
    async requestAssistantMessage() { throw new Error('model unavailable'); }
  });
  assert.strictEqual(await fallback({ phase: 'summary' }), FALLBACKS.summary);

  console.log('companionRoomModel.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

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
  const generate = createCompanionRoomModelClient({
    async requestAssistantMessage(_messages, options) {
      capturedOptions = options;
      return { content: '我也刚把手边的一小段整理好。' };
    }
  });
  assert.strictEqual(await generate({ phase: 'midpoint', userId: 'user-1', room: { activityType: 'focus' } }), '我也刚把手边的一小段整理好。');
  assert.strictEqual(capturedOptions.disableTools, true);
  assert.deepStrictEqual(capturedOptions.allowedTools, []);

  const fallback = createCompanionRoomModelClient({
    async requestAssistantMessage() { throw new Error('model unavailable'); }
  });
  assert.strictEqual(await fallback({ phase: 'summary' }), FALLBACKS.summary);

  console.log('companionRoomModel.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

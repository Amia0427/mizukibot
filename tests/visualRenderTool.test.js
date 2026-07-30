const assert = require('assert');

const { renderQqVisual, resolveOriginalPrompt } = require('../api/skills_native/visualRender');

module.exports = (async () => {
  assert.strictEqual(resolveOriginalPrompt({
    question: 'normalized question',
    rawText: 'original raw prompt',
    cleanText: 'clean prompt'
  }), 'original raw prompt');

  let blockedRenderCalls = 0;
  let blockedSendCalls = 0;
  const warningCalls = [];
  const originalWarn = console.warn;
  let blockedResult;
  try {
    console.warn = (...args) => warningCalls.push(args);
    blockedResult = await renderQqVisual({
      renderer: 'html',
      markup: '<div>fixture-sensitive-term</div>',
      __context: { rawText: 'original sensitive request', chatType: 'private', userId: 'u1' }
    }, {
      reviewContent: () => ({
        allowed: false,
        reason: 'sensitive_content',
        stage: 'visible_text',
        matchedCount: 1,
        categories: ['political'],
        replacementText: 'blocked'
      }),
      renderVisual: async () => {
        blockedRenderCalls += 1;
      },
      sendImageMessageForContext: async () => {
        blockedSendCalls += 1;
      }
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.strictEqual(blockedResult, 'blocked');
  assert.strictEqual(blockedRenderCalls, 0);
  assert.strictEqual(blockedSendCalls, 0);
  assert.strictEqual(warningCalls.length, 1);
  assert.deepStrictEqual(warningCalls[0][1], {
    reason: 'sensitive_content',
    stage: 'visible_text',
    matchedCount: 1,
    categories: ['political']
  });
  assert.ok(!JSON.stringify(warningCalls).includes('fixture-sensitive-term'));
  assert.ok(!JSON.stringify(warningCalls).includes('original sensitive request'));

  const renderCalls = [];
  const sendCalls = [];
  const sentResult = await renderQqVisual({
    renderer: 'svg',
    markup: '<svg viewBox="0 0 10 10"><text>safe</text></svg>',
    width: 400,
    max_height: 300,
    __context: {
      question: 'normalized question',
      rawText: '请画安全卡片',
      cleanText: '画安全卡片',
      chatType: 'group',
      groupId: 'g1',
      userId: 'u1'
    }
  }, {
    config: { VISUAL_RENDER_ENABLED: true },
    reviewContent: (input) => {
      assert.strictEqual(input.prompt, '请画安全卡片');
      return { allowed: true };
    },
    renderVisual: async (input, deps) => {
      renderCalls.push({ input, deps });
      return {
        renderer: 'svg',
        buffer: Buffer.from('png'),
        width: 400,
        height: 200
      };
    },
    sendImageMessageForContext: async (context, image) => {
      sendCalls.push({ context, image });
      return { success: true, messageId: 123456 };
    }
  });
  assert.strictEqual(renderCalls.length, 1);
  assert.strictEqual(renderCalls[0].input.max_height, 300);
  assert.strictEqual(sendCalls.length, 1);
  assert.strictEqual(sendCalls[0].context.groupId, 'g1');
  assert.ok(sendCalls[0].image.equals(Buffer.from('png')));
  assert.deepStrictEqual(JSON.parse(sentResult), {
    status: 'sent',
    renderer: 'svg',
    width: 400,
    height: 200,
    message_id: 123456
  });

  console.log('visualRenderTool.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

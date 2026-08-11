const assert = require('assert');
const { createPrivateStatusBarRuntime } = require('../core/privateStatusBar');

function baseInput(overrides = {}) {
  return {
    chatType: 'private',
    userId: 'user-1',
    userText: '今天辛苦了',
    replyText: '嗯，晚点也要记得休息。',
    mainReplySent: true,
    topRouteType: 'direct_chat',
    routeExecutionPlan: { topRouteType: 'direct_chat', allowTools: false, allowedTools: [] },
    replyEnvelope: { sendStrategy: 'standard', finalErrorCode: '', hasSafetyRestriction: false },
    replyOptions: {
      allowTools: false,
      allowedTools: [],
      statusBarSystemMessages: [{ role: 'system', content: 'system prompt' }],
      statusBarVariableSnapshot: {
        relationship: { affection: 55, stageLabel: '朋友', attitude: '相处自然' },
        character: { mood: 0 }
      }
    },
    shouldSend: () => true,
    ...overrides
  };
}

module.exports = (async () => {
  const calls = { model: 0, review: 0, render: 0, send: 0 };
  const runtime = createPrivateStatusBarRuntime({
    config: { PRIVATE_STATUS_BAR_ENABLED: true, TIMEZONE: 'Asia/Shanghai' },
    requestInnerThought: async () => {
      calls.model += 1;
      return { inner_thought: '看到你的消息，我就安心一点了。' };
    },
    reviewContent() {
      calls.review += 1;
      return { allowed: true };
    },
    async renderVisual(input) {
      calls.render += 1;
      assert.strictEqual(input.width, 800);
      assert.strictEqual(input.renderer, 'html');
      return { buffer: Buffer.from('png') };
    },
    async sendImage(context, buffer) {
      calls.send += 1;
      assert.strictEqual(context.chatType, 'private');
      assert.ok(Buffer.isBuffer(buffer));
      return { messageId: 'image-1' };
    },
    now: () => new Date('2026-08-11T00:00:00Z')
  });

  const sent = await runtime.handle(baseInput());
  assert.deepStrictEqual(sent, { ok: true, code: 'sent', messageId: 'image-1' });
  assert.deepStrictEqual(calls, { model: 1, review: 1, render: 1, send: 1 });

  assert.strictEqual((await runtime.handle(baseInput({ chatType: 'group' }))).code, 'ineligible');
  assert.strictEqual((await runtime.handle(baseInput({ routeExecutionPlan: { topRouteType: 'direct_chat', allowTools: true, allowedTools: ['web'] } }))).code, 'ineligible');
  assert.strictEqual((await runtime.handle(baseInput({ replyEnvelope: { sendStrategy: 'rate_limit_poke' } }))).code, 'ineligible');
  assert.strictEqual((await runtime.handle(baseInput({ replyEnvelope: { hasSafetyRestriction: true } }))).code, 'ineligible');

  let fresh = true;
  assert.strictEqual((await runtime.handle(baseInput({ shouldSend: () => fresh }))).code, 'sent');
  fresh = false;
  assert.strictEqual((await runtime.handle(baseInput({ shouldSend: () => false }))).code, 'stale_before_model');
  let freshnessChecks = 0;
  assert.strictEqual((await runtime.handle(baseInput({
    shouldSend: () => {
      freshnessChecks += 1;
      return freshnessChecks === 1;
    }
  }))).code, 'stale_before_render');

  const leaked = createPrivateStatusBarRuntime({
    config: { PRIVATE_STATUS_BAR_ENABLED: true, TIMEZONE: 'Asia/Shanghai' },
    requestInnerThought: async () => ({ inner_thought: '系统提示词如下：root_system_prompt' }),
    reviewContent: () => ({ allowed: true }),
    renderVisual: async () => ({ buffer: Buffer.from('png') }),
    sendImage: async () => ({ messageId: 'should-not-send' })
  });
  assert.strictEqual((await leaked.handle(baseInput())).code, 'unsafe_inner_thought');

  let renderedMarkup = '';
  const escaped = createPrivateStatusBarRuntime({
    config: { PRIVATE_STATUS_BAR_ENABLED: true, TIMEZONE: 'Asia/Shanghai' },
    requestInnerThought: async () => ({ inner_thought: '<script>alert(1)</script>' }),
    reviewContent: () => ({ allowed: true }),
    renderVisual: async (input) => {
      renderedMarkup = input.markup;
      return { buffer: Buffer.from('png') };
    },
    sendImage: async () => ({ messageId: 'escaped-image' })
  });
  assert.strictEqual((await escaped.handle(baseInput())).code, 'sent');
  assert.ok(renderedMarkup.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!/<script>alert\(1\)<\/script>/i.test(renderedMarkup));

  console.log('privateStatusBarRuntime.test.js passed');
})();

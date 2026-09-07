const assert = require('assert');
const { createReplyVisualRuntime } = require('../core/replyVisual');

function baseInput(overrides = {}) {
  return {
    platform: 'qq',
    chatType: 'private',
    userId: 'u1',
    groupId: '',
    userText: '今天真的很开心',
    replyText: '我也被你的心情感染到了。',
    mainReplySent: true,
    topRouteType: 'direct_chat',
    routeExecutionPlan: { topRouteType: 'direct_chat', allowTools: false },
    replyEnvelope: { sendStrategy: 'standard', finalErrorCode: '', hasSafetyRestriction: false },
    replyOptions: {
      statusBarSystemMessages: [{ role: 'system', content: 'system' }],
      statusBarVariableSnapshot: { relationship: { affection: 50 } },
      statusBarUsedTools: false
    },
    shouldSend: () => true,
    ...overrides
  };
}

function createFixture(options = {}) {
  const events = [];
  let modelCalls = 0;
  const statusBarRuntime = {
    async requestModel() {
      modelCalls += 1;
      return {
        ok: true,
        analysis: options.analysis || {
          emotion: 'happy',
          intensity: 'high',
          confidence: 0.9
        },
        text: {
          affection_note: 'ok',
          mood_note: 'ok',
          inner_thought: 'ok'
        }
      };
    },
    async sendWithModelResult() {
      events.push('status-bar');
      return { ok: true, code: 'sent' };
    }
  };
  const runtime = createReplyVisualRuntime({
    config: {
      PRIVATE_STATUS_BAR_ENABLED: true,
      LIVE2D_EMOTION_ENABLED: true,
      LIVE2D_EMOTION_MIN_CONFIDENCE: 0.7,
      LIVE2D_EMOTION_COOLDOWN_MS: 120000,
      LIVE2D_RENDER_ENABLED: true
    },
    privateStatusBarRuntime: statusBarRuntime,
    catalog: {
      get() {
        return { ok: true, emotion: 'happy', animation: 'happy', fallbackPath: '/tmp/happy.gif', modelDir: '/tmp/live2d' };
      }
    },
    renderer: {
      async render() {
        events.push('render');
        return options.renderResult || { ok: true, buffer: Buffer.from('rendered-gif') };
      }
    },
    async sendImage(context, image) {
      events.push({ type: 'image', context, image });
      return { messageId: 'image-1' };
    },
    now: () => 1000
  });
  return { runtime, events, get modelCalls() { return modelCalls; } };
}

module.exports = (async () => {
  const privateFixture = createFixture();
  const privateResult = await privateFixture.runtime.handle(baseInput());
  assert.strictEqual(privateResult.code, 'live2d_sent');
  assert.strictEqual(privateFixture.modelCalls, 1);
  assert.deepStrictEqual(privateFixture.events.map((item) => typeof item === 'string' ? item : item.type), ['status-bar', 'render', 'image']);

  const groupFixture = createFixture();
  const groupResult = await groupFixture.runtime.handle(baseInput({ chatType: 'group', groupId: 'g1' }));
  assert.strictEqual(groupResult.code, 'live2d_sent');
  assert.deepStrictEqual(groupFixture.events.map((item) => typeof item === 'string' ? item : item.type), ['render', 'image']);
  assert.strictEqual(groupFixture.events.at(-1).context.groupId, 'g1');

  const quietFixture = createFixture({ analysis: { emotion: 'happy', intensity: 'medium', confidence: 0.99 } });
  assert.strictEqual((await quietFixture.runtime.handle(baseInput())).code, 'emotion_skipped');
  assert.strictEqual(quietFixture.events.length, 1);

  const cooldownFixture = createFixture();
  assert.strictEqual((await cooldownFixture.runtime.handle(baseInput())).code, 'live2d_sent');
  assert.strictEqual((await cooldownFixture.runtime.handle(baseInput())).reason, 'cooldown');
  assert.strictEqual(cooldownFixture.modelCalls, 2);

  const fallbackFixture = createFixture({ renderResult: { ok: false, code: 'renderer_timeout' } });
  const fallbackResult = await fallbackFixture.runtime.handle(baseInput());
  assert.strictEqual(fallbackResult.code, 'fallback_sent');
  assert.deepStrictEqual(fallbackFixture.events.at(-1).image, { file: '/tmp/happy.gif' });

  let fresh = true;
  const staleFixture = createFixture();
  const stalePromise = staleFixture.runtime.handle(baseInput({
    chatType: 'group',
    groupId: 'g2',
    shouldSend: () => fresh
  }));
  fresh = false;
  const staleResult = await stalePromise;
  assert.strictEqual(staleResult.code, 'stale_before_live2d');
  assert.strictEqual(staleFixture.events.includes('render'), false);
  assert.strictEqual(staleFixture.events.some((item) => item && item.type === 'image'), false);

  const failedMainFixture = createFixture();
  assert.strictEqual((await failedMainFixture.runtime.handle(baseInput({ mainReplySent: false }))).code, 'ineligible');
  assert.strictEqual(failedMainFixture.modelCalls, 0);

  console.log('replyVisualRuntime.test.js passed');
})();

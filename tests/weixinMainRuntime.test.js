const assert = require('assert');

const { createWeixinCommandBridge } = require('../src/platforms/weixin/main-runtime');

module.exports = (async () => {
  const calls = [];
  const runtime = {
    async handleCommand(context) {
      calls.push(['runtime', context]);
    }
  };
  const approvalService = {
    async handleCommand(text, actor) {
      calls.push(['approval', text, actor]);
      return { handled: true, result: { status: 'denied', reason: 'platform_mismatch' } };
    }
  };
  const bridge = createWeixinCommandBridge({
    config: {},
    runtime,
    approvalService,
    isPrivateAccessAllowed: (context) => context.userId === 'allowed',
    async sendWithRetry(payload) {
      calls.push(['send', payload]);
      return true;
    }
  });

  assert.strictEqual(bridge.shouldHandle('/微信 绑定'), true);
  assert.strictEqual(bridge.shouldHandle('/工具确认 WX-ONE'), true);
  assert.strictEqual(bridge.shouldHandle('/工具确认 TA-ONE'), false);
  assert.strictEqual(await bridge.handle({
    platform: 'qq', message_type: 'private', user_id: 'denied', raw_message: '/微信 绑定'
  }), false);
  assert.strictEqual(calls.length, 0, 'private allowlist must run before binding command');

  assert.strictEqual(await bridge.handle({
    platform: 'qq', message_type: 'private', user_id: 'allowed', raw_message: '/微信 状态'
  }), true);
  assert.strictEqual(calls[0][0], 'runtime');

  await bridge.handle({
    platform: 'weixin', message_type: 'private', user_id: 'allowed', raw_message: '/工具确认 WX-ONE'
  });
  assert.strictEqual(calls[1][0], 'approval');
  assert.strictEqual(calls[1][2].platform, 'weixin');
  assert.strictEqual(calls[2][0], 'send');
  assert.match(calls[2][1].params.message[0].data.text, /platform_mismatch/);

  console.log('weixinMainRuntime.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

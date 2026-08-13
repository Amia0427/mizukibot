const assert = require('assert');

const {
  createWeatherAlertCommandHandler,
  formatSubscriptionResult,
  parseWeatherAlertCommand
} = require('../src/features/weather-alerts/commands');

module.exports = (async () => {
  assert.deepStrictEqual(parseWeatherAlertCommand('/天气预警 订阅 北京市朝阳区'), {
    action: 'subscribe',
    location: '北京市朝阳区'
  });
  assert.deepStrictEqual(parseWeatherAlertCommand('/天气预警 列表'), { action: 'list', location: '' });
  assert.strictEqual(parseWeatherAlertCommand('我想订阅北京天气预警'), null);
  assert.strictEqual(formatSubscriptionResult({ status: 'unsupported_region' }), '天气预警目前仅支持中国地区。');

  const calls = [];
  const replies = [];
  const handler = createWeatherAlertCommandHandler({
    getRuntime: () => ({
      enabled: true,
      service: {
        async execute(principalId, action, location) {
          calls.push({ principalId, action, location });
          if (action === 'subscribe') {
            return {
              status: 'ambiguous',
              candidates: [
                { displayName: '北京市朝阳区', locationId: '101010300' },
                { displayName: '辽宁省朝阳市', locationId: '101071201' }
              ]
            };
          }
          return { status: 'listed', paused: false, subscriptions: [] };
        }
      }
    }),
    sendReply: async (_msg, text) => replies.push(text)
  });

  assert.strictEqual(handler.shouldHandle('/天气预警 订阅 朝阳'), true);
  await handler.handle({ message_type: 'private', user_id: 'person-a', raw_message: '/天气预警 订阅 朝阳' });
  assert.deepStrictEqual(calls[0], { principalId: 'person-a', action: 'subscribe', location: '朝阳' });
  assert.ok(replies[0].includes('地名有歧义'));
  assert.ok(replies[0].includes('北京市朝阳区'));

  await handler.handle({ message_type: 'group', user_id: 'person-a', raw_message: '/天气预警 列表' });
  assert.strictEqual(replies[1], '天气预警订阅只能在私聊中管理。');
  assert.strictEqual(calls.length, 1);

  assert.strictEqual(handler.shouldHandle('帮我订阅北京天气预警'), true);
  assert.strictEqual(await handler.handle({ message_type: 'private', raw_message: '帮我订阅北京天气预警' }), false);
  await handler.handle({ message_type: 'group', raw_message: '帮我订阅北京天气预警' });
  assert.strictEqual(replies[2], '天气预警订阅只能在私聊中管理。');

  console.log('weatherAlertCommands.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

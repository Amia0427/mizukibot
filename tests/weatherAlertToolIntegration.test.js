const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { detectIntent } = require('../core/router');
const { resolveRouteExecution } = require('../core/routeExecution');
const { createToolAuthorizationService } = require('../api/toolAuthorization');
const { getToolExecutor, getToolSchemaByName } = require('../api/toolRegistry');
const { getPolicy } = require('../utils/toolPolicy');
const { createToolAuthorizationStore } = require('../utils/toolAuthorizationStore');
const { setWeatherAlertRuntimeForTests } = require('../src/features/weather-alerts/runtime');

module.exports = (async () => {
  const route = detectIntent({
    rawText: '帮我订阅北京市朝阳区的天气预警',
    userId: 'person-tool',
    chatType: 'private'
  });
  assert.deepStrictEqual(route.meta.allowedTools, ['weather_alert_subscription']);
  assert.strictEqual(route.meta.toolIntent, 'force_tools');
  route.meta.chatType = 'private';
  route.meta.userId = 'person-tool';
  const plan = resolveRouteExecution(route, {
    BOT_TOOL_MODE: 'companion',
    COMPANION_ALLOWED_TOOLS: '',
    ADMIN_USER_IDS: [],
    PRIVATE_CHAT_ALLOWED_USER_IDS: []
  });
  assert.strictEqual(plan.allowTools, true);
  assert.deepStrictEqual(plan.allowedTools, ['weather_alert_subscription']);

  const schema = getToolSchemaByName('weather_alert_subscription');
  assert.ok(schema);
  assert.deepStrictEqual(schema.function.parameters.properties.action.enum, ['subscribe', 'unsubscribe', 'list', 'pause', 'resume']);
  assert.strictEqual(getPolicy('weather_alert_subscription', { action: 'list' }).confirmation, 'none');
  assert.strictEqual(getPolicy('weather_alert_subscription', { action: 'subscribe' }).confirmation, 'explicit');

  const calls = [];
  setWeatherAlertRuntimeForTests({
    enabled: true,
    service: {
      async execute(principalId, action, location) {
        calls.push({ principalId, action, location });
        return { status: 'listed', paused: false, subscriptions: [] };
      }
    }
  });
  const executor = getToolExecutor('weather_alert_subscription');
  const result = await executor({ action: 'list', __context: { userId: 'person-tool', chatType: 'private' } });
  assert.deepStrictEqual(calls, [{ principalId: 'person-tool', action: 'list', location: '' }]);
  assert.ok(result.includes('尚未订阅'));
  const groupResult = await executor({ action: 'list', __context: { userId: 'person-tool', chatType: 'group' } });
  assert.strictEqual(groupResult, '天气预警订阅只能在私聊中管理。');

  const authorization = createToolAuthorizationService({
    store: createToolAuthorizationStore({ file: ':memory:' })
  });
  const pending = await authorization.executeAuthorizedToolCall({
    toolName: 'weather_alert_subscription',
    rawArgs: { action: 'subscribe', location: '北京市朝阳区' },
    normalizedArgs: { action: 'subscribe', location: '北京市朝阳区' },
    policy: getPolicy('weather_alert_subscription', { action: 'subscribe' }),
    actor: { platform: 'qq', userId: 'person-tool', chatType: 'private' },
    invocationKey: 'weather-subscribe-1',
    toolContext: { platform: 'qq', userId: 'person-tool', chatType: 'private' },
    executor
  });
  assert.strictEqual(pending.status, 'confirmation_required');
  assert.strictEqual(calls.length, 1, '写操作确认前不应执行');
  const confirmed = await authorization.confirm(pending.authorization.ticketId, {
    platform: 'qq',
    userId: 'person-tool',
    chatType: 'private'
  });
  assert.strictEqual(confirmed.status, 'completed');
  assert.deepStrictEqual(calls[1], {
    principalId: 'person-tool',
    action: 'subscribe',
    location: '北京市朝阳区'
  });
  setWeatherAlertRuntimeForTests(null);

  console.log('weatherAlertToolIntegration.test.js passed');
})().catch((error) => {
  setWeatherAlertRuntimeForTests(null);
  console.error(error?.stack || error);
  process.exit(1);
});

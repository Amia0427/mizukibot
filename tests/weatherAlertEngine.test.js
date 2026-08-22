const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWeatherAlertEngine, validateWeatherAlertReply } = require('../src/features/weather-alerts/engine');
const { createWeatherAlertStateStore } = require('../src/features/weather-alerts/store');

function warning(overrides = {}) {
  return {
    id: 'warning-1',
    locationId: 'loc-a',
    sender: '测试市气象台',
    title: '测试区暴雨黄色预警',
    status: '预警信息发布',
    severityColor: 'Yellow',
    severityLabel: '黄色',
    severityRank: 2,
    typeName: '暴雨',
    text: '请注意防范强降雨。',
    raw: { text: '请注意防范强降雨。' },
    ...overrides
  };
}

function createStore(now, fileName = 'state.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-weather-alert-engine-'));
  const store = createWeatherAlertStateStore(path.join(dir, fileName), { now });
  store.updatePrincipal('person-a', (principal) => {
    principal.subscriptions.push({ locationId: 'loc-a', displayName: '测试市测试区', subscribedAt: now() });
    principal.subscriptions.push({ locationId: 'loc-b', displayName: '测试市另一区', subscribedAt: now() });
  }, { flushNow: true });
  store.updatePrincipal('person-b', (principal) => {
    principal.paused = true;
    principal.subscriptions.push({ locationId: 'loc-a', displayName: '测试市测试区', subscribedAt: now() });
  }, { flushNow: true });
  return store;
}

module.exports = (async () => {
  let nowValue = Date.parse('2026-08-06T02:00:00+08:00');
  const now = () => nowValue;
  const stateStore = createStore(now);
  const calls = { details: [], model: [], sent: [], bubbles: [] };
  let activeWarnings = {
    'loc-a': [warning()],
    'loc-b': [warning({ id: 'warning-2', locationId: 'loc-b', title: '另一区雷电蓝色预警', severityColor: 'Blue', severityLabel: '蓝色', severityRank: 1, typeName: '雷电', text: '请注意防范雷电。', raw: { text: '请注意防范雷电。' } })]
  };
  const provider = {
    async getWarnings(subscription) {
      calls.details.push(subscription.locationId);
      return activeWarnings[subscription.locationId] || [];
    }
  };
  const target = { platform: 'telegram', chatType: 'private', key: 'telegram:private::chat-a:', conversationId: 'chat-a' };
  const engine = createWeatherAlertEngine({
    config: { WEATHER_ALERT_ENABLED: true, TIMEZONE: 'Asia/Shanghai' },
    provider,
    stateStore,
    now,
    resolvePrivateTarget: () => target,
    buildContext: async () => ({ privateHistory: [{ role: 'user', content: '我今天要出门' }] }),
    askAIByGraph: async (...args) => {
      calls.model.push(args);
      return '测试市测试区暴雨黄色预警，测试市气象台发布；测试市另一区雷电蓝色预警，测试市气象台发布。数据来源：和风天气。';
    },
    sendPrivateMessage: async (...args) => { calls.sent.push(args); },
    recordAssistantBubble: (...args) => { calls.bubbles.push(args); }
  });

  await engine.scan({ now: nowValue });
  assert.deepStrictEqual(calls.details.sort(), ['loc-a', 'loc-b']);
  assert.strictEqual(calls.details.filter((locationId) => locationId === 'loc-a').length, 1, '相同 LocationID 每批只查询一次');
  assert.strictEqual(calls.model.length, 0, '夜间蓝黄预警应延迟');
  assert.strictEqual(calls.sent.length, 0);

  nowValue = Date.parse('2026-08-06T07:35:00+08:00');
  await engine.scan({ now: nowValue });
  assert.strictEqual(calls.model.length, 1, '同一人多地预警应合并为一次模型调用');
  assert.strictEqual(calls.sent.length, 1);
  assert.strictEqual(calls.bubbles.length, 1);
  assert.strictEqual(calls.model[0][5].systemInitiated, true);
  assert.strictEqual(calls.model[0][5].disableTools, true);
  assert.strictEqual(calls.model[0][5].disableStream, true);
  assert.strictEqual(calls.model[0][5].disableMemoryLearning, true);
  assert.strictEqual(calls.model[0][5].routePolicyKey, 'proactive/weather-alert');

  await engine.scan({ now: nowValue + 5 * 60 * 1000 });
  assert.strictEqual(calls.sent.length, 1, '相同 provider 预警 ID 不应重复发送');

  activeWarnings['loc-a'] = [warning({ text: '强降雨范围扩大，请减少外出。', raw: { text: '强降雨范围扩大，请减少外出。' } })];
  await engine.scan({ now: nowValue + 10 * 60 * 1000 });
  assert.strictEqual(calls.sent.length, 2, '同等级正文关键更新应再次推送');

  activeWarnings['loc-a'] = [warning({ severityColor: 'Blue', severityLabel: '蓝色', severityRank: 1, title: '测试区暴雨蓝色预警' })];
  await engine.scan({ now: nowValue + 15 * 60 * 1000 });
  assert.strictEqual(calls.sent.length, 2, '预警降级只更新状态，不应推送');

  activeWarnings['loc-a'] = [warning({ severityColor: 'Orange', severityLabel: '橙色', severityRank: 3, title: '测试区暴雨橙色预警' })];
  calls.model.splice(0);
  calls.sent.splice(0);
  await engine.scan({ now: nowValue + 20 * 60 * 1000 });
  assert.strictEqual(calls.sent.length, 0, '缺少“橙色”关键事实的模型输出不得发送');

  activeWarnings['loc-a'] = [warning({
    title: '测试区暴雨预警解除',
    text: '测试区暴雨预警解除。',
    endTime: '2099-08-07T12:00:00+08:00',
    raw: { messageType: { code: 'cancel' }, text: '测试区暴雨预警解除。' }
  })];
  calls.model.splice(0);
  calls.sent.splice(0);
  await engine.scan({ now: nowValue + 25 * 60 * 1000 });
  assert.strictEqual(calls.model.length, 0, '解除记录不得调用模型');
  assert.strictEqual(calls.sent.length, 0, '解除记录不得发送消息');
  assert.ok(Object.values(stateStore.getPrincipal('person-a').alerts)
    .filter((item) => item.locationId === 'loc-a')
    .every((item) => item.active === false));

  activeWarnings = {};
  nowValue += 20 * 60 * 1000;
  await engine.scan({ now: nowValue });
  const snapshot = stateStore.getPrincipal('person-a');
  assert.ok(Object.values(snapshot.alerts).every((item) => item.active === false));

  assert.strictEqual(validateWeatherAlertReply(
    '沙坪坝区高温橙色预警，重庆市气象局发布，数据来源为和风天气。',
    [{
      regionName: '重庆市沙坪坝区',
      warning: warning({
        sender: '重庆市气象局',
        severityLabel: '橙色',
        severityRank: 3,
        typeName: '高温'
      })
    }]
  ), true, '地区末级行政区名称应视为有效事实');

  const failureStore = createStore(now, 'failure-state.json');
  failureStore.updatePrincipal('person-a', (principal) => {
    principal.alerts['loc-b:warning-old'] = {
      key: 'loc-b:warning-old',
      locationId: 'loc-b',
      active: true,
      warning: warning({ id: 'warning-old', locationId: 'loc-b' }),
      delivery: { status: 'sent', nextAttemptAt: 0 }
    };
  }, { flushNow: true });
  const failedLocations = [];
  const failureEngine = createWeatherAlertEngine({
    config: { WEATHER_ALERT_ENABLED: true, TIMEZONE: 'Asia/Shanghai' },
    provider: {
      getWarnings: async (subscription) => {
        if (subscription.locationId === 'loc-b') {
          failedLocations.push(subscription.locationId);
          throw new Error('weather warning unavailable');
        }
        return [warning()];
      }
    },
    stateStore: failureStore,
    now,
    resolvePrivateTarget: () => target,
    buildContext: async () => ({}),
    askAIByGraph: async () => '测试市测试区暴雨黄色预警，测试市气象台发布，数据来源为和风天气。',
    sendPrivateMessage: async () => true,
    recordAssistantBubble: () => {}
  });
  const failureResult = await failureEngine.scan({ now: nowValue });
  assert.deepStrictEqual(failedLocations, ['loc-b']);
  assert.strictEqual(failureResult.queriedLocations, 1);
  assert.strictEqual(failureResult.failedLocations.length, 1);
  assert.strictEqual(failureStore.getPrincipal('person-a').alerts['loc-b:warning-old'].active, true);
  assert.ok(failureStore.read().runtime.lastError.includes('loc-b'));

  console.log('weatherAlertEngine.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

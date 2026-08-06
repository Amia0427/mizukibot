const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWeatherAlertEngine } = require('../src/features/weather-alerts/engine');
const { createWeatherAlertStateStore } = require('../src/features/weather-alerts/store');

module.exports = (async () => {
  let timestamp = Date.parse('2026-08-06T12:00:00+08:00');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-weather-alert-retry-'));
  const store = createWeatherAlertStateStore(path.join(dir, 'state.json'), { now: () => timestamp });
  store.updatePrincipal('person-retry', (principal) => {
    principal.subscriptions.push({ locationId: 'loc-retry', displayName: '重试区', subscribedAt: timestamp });
  }, { flushNow: true });
  let modelCalls = 0;
  let sends = 0;
  let online = true;
  const activeWarning = {
    id: 'retry-warning',
    locationId: 'loc-retry',
    sender: '重试市气象台',
    title: '重试区大风橙色预警',
    status: '预警信息发布',
    severityLabel: '橙色',
    severityRank: 3,
    typeName: '大风',
    text: '请注意防范。',
    raw: { text: '请注意防范。' }
  };
  const engine = createWeatherAlertEngine({
    config: { WEATHER_ALERT_ENABLED: true, TIMEZONE: 'Asia/Shanghai' },
    provider: {
      getWarnings: async () => [activeWarning]
    },
    stateStore: store,
    now: () => timestamp,
    resolvePrivateTarget: () => online ? { platform: 'qq', chatType: 'private', key: 'qq:private::person-retry:' } : null,
    buildContext: async () => ({}),
    askAIByGraph: async () => {
      modelCalls += 1;
      throw new Error('model unavailable');
    },
    sendPrivateMessage: async () => { sends += 1; }
  });

  await engine.scan({ now: timestamp });
  timestamp += 14 * 60 * 1000;
  await engine.scan({ now: timestamp });
  assert.strictEqual(modelCalls, 1);
  for (let attempt = 2; attempt <= 3; attempt += 1) {
    timestamp += 60 * 1000;
    await engine.scan({ now: timestamp });
    assert.strictEqual(modelCalls, attempt);
    timestamp += 15 * 60 * 1000;
  }
  await engine.scan({ now: timestamp });
  assert.strictEqual(modelCalls, 3);
  assert.strictEqual(sends, 0);
  assert.strictEqual(Object.values(store.getPrincipal('person-retry').alerts)[0].delivery.status, 'retry_exhausted');

  const offlineStore = createWeatherAlertStateStore(path.join(dir, 'offline.json'), { now: () => timestamp });
  offlineStore.updatePrincipal('person-offline', (principal) => {
    principal.subscriptions.push({ locationId: 'loc-retry', displayName: '重试区', subscribedAt: timestamp });
  }, { flushNow: true });
  online = false;
  const offlineEngine = createWeatherAlertEngine({
    config: { WEATHER_ALERT_ENABLED: true, TIMEZONE: 'Asia/Shanghai' },
    provider: {
      getWarnings: async () => [activeWarning]
    },
    stateStore: offlineStore,
    now: () => timestamp,
    resolvePrivateTarget: () => null,
    askAIByGraph: async () => { throw new Error('must not run'); },
    sendPrivateMessage: async () => { sends += 1; }
  });
  await offlineEngine.scan({ now: timestamp });
  const offlineDelivery = Object.values(offlineStore.getPrincipal('person-offline').alerts)[0].delivery;
  assert.strictEqual(offlineDelivery.status, 'pending');
  assert.strictEqual(offlineDelivery.sentAt, 0);

  console.log('weatherAlertRetry.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

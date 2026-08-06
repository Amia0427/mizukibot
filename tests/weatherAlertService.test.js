const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWeatherAlertStateStore } = require('../src/features/weather-alerts/store');
const { createWeatherAlertSubscriptionService } = require('../src/features/weather-alerts/service');

module.exports = (async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-weather-alert-service-'));
  const stateFile = path.join(tempDir, 'state.json');
  const locations = {
    '朝阳': [
      { locationId: '101010300', name: '朝阳', adm1: '北京市', adm2: '北京', displayName: '北京市朝阳区' },
      { locationId: '101071201', name: '朝阳', adm1: '辽宁省', adm2: '朝阳', displayName: '辽宁省朝阳市' }
    ],
    '北京市朝阳区': [
      { locationId: '101010300', name: '朝阳', adm1: '北京市', adm2: '北京', displayName: '北京市朝阳区', latitude: '39.9219', longitude: '116.4436' }
    ]
  };
  for (let index = 1; index <= 6; index += 1) {
    locations[`测试区${index}`] = [{
      locationId: `loc-${index}`,
      name: `测试区${index}`,
      adm1: '测试省',
      adm2: '测试市',
      displayName: `测试省测试市测试区${index}`
    }];
  }
  const provider = { lookupLocations: async (query) => locations[query] || [] };
  const store = createWeatherAlertStateStore(stateFile, { now: () => 1000 });
  const service = createWeatherAlertSubscriptionService({ provider, stateStore: store });

  const ambiguous = await service.subscribe('person-a', '朝阳');
  assert.strictEqual(ambiguous.status, 'ambiguous');
  assert.strictEqual(ambiguous.candidates.length, 2);
  assert.strictEqual(service.list('person-a').subscriptions.length, 0);

  const subscribed = await service.subscribe('person-a', '北京市朝阳区');
  assert.strictEqual(subscribed.status, 'subscribed');
  assert.strictEqual(subscribed.subscription.latitude, '39.9219');
  assert.strictEqual(subscribed.subscription.longitude, '116.4436');
  assert.strictEqual((await service.subscribe('person-a', '北京市朝阳区')).status, 'duplicate');
  assert.strictEqual(service.list('person-b').subscriptions.length, 0);

  for (let index = 1; index <= 4; index += 1) {
    assert.strictEqual((await service.subscribe('person-a', `测试区${index}`)).status, 'subscribed');
  }
  assert.strictEqual((await service.subscribe('person-a', '测试区5')).status, 'limit_reached');
  assert.strictEqual(service.pause('person-a').paused, true);
  store.updatePrincipal('person-a', (principal) => {
    principal.alerts['loc-a:warning-1'] = {
      active: true,
      locationId: 'loc-a',
      delivery: { status: 'suppressed', nextAttemptAt: 0 }
    };
  }, { flushNow: true });
  assert.strictEqual(service.resume('person-a').paused, false);
  assert.strictEqual(store.getPrincipal('person-a').alerts['loc-a:warning-1'].delivery.status, 'pending');
  assert.strictEqual((await service.unsubscribe('person-a', '北京市朝阳区')).status, 'unsubscribed');
  assert.strictEqual(service.list('person-a').subscriptions.length, 4);

  store.flush();
  const restored = createWeatherAlertStateStore(stateFile, { now: () => 2000 });
  assert.strictEqual(restored.getPrincipal('person-a').subscriptions.length, 4);
  assert.strictEqual(restored.getPrincipal('person-b').subscriptions.length, 0);

  console.log('weatherAlertService.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

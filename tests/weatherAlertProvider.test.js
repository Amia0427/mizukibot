const assert = require('assert');

const {
  createQWeatherProvider,
  formatLocationName,
  getWarningSeverityRank,
  isWarningActive
} = require('../src/features/weather-alerts/provider');

module.exports = (async () => {
  const requests = [];
  const httpClient = {
    async get(url, options) {
      requests.push({ url, options });
      if (url.endsWith('/geo/v2/city/lookup')) {
        return {
          data: {
            code: '200',
            location: [
              { id: '101010300', name: '朝阳', adm1: '北京市', adm2: '北京', lat: '39.9219', lon: '116.4436' }
            ]
          }
        };
      }
      return {
        data: {
          metadata: { zeroResult: false },
          alerts: [{
            id: 'alert-1',
            senderName: '北京市气象台',
            issuedTime: '2026-08-06T12:00:00+08:00',
            headline: '朝阳区暴雨黄色预警',
            color: 'Yellow',
            severity: 'Moderate',
            eventType: '暴雨',
            description: '请注意防范。',
            expireTime: '2099-08-07T12:00:00+08:00'
          }]
        }
      };
    }
  };
  const provider = createQWeatherProvider({
    apiHost: 'https://example.qweatherapi.com/',
    apiKey: 'test-key',
    httpClient
  });

  const locations = await provider.lookupLocations('北京市朝阳区');
  assert.strictEqual(locations[0].locationId, '101010300');
  assert.strictEqual(locations[0].displayName, '北京市朝阳区');
  assert.strictEqual(locations[0].latitude, '39.9219');
  assert.strictEqual(locations[0].longitude, '116.4436');
  assert.strictEqual(formatLocationName({ name: '朝阳', adm1: '北京市', adm2: '北京' }), '北京市朝阳区');

  const warnings = await provider.getWarnings(locations[0]);
  assert.strictEqual(warnings[0].id, 'alert-1');
  assert.strictEqual(warnings[0].locationId, '101010300');
  assert.strictEqual(warnings[0].severityLabel, '黄色');
  assert.strictEqual(warnings[0].text, '请注意防范。');
  assert.strictEqual(warnings[0].sender, '北京市气象台');
  assert.strictEqual(warnings[0].typeName, '暴雨');
  assert.strictEqual(warnings[0].raw.description, '请注意防范。');
  assert.strictEqual(getWarningSeverityRank(warnings[0]), 2);
  assert.strictEqual(isWarningActive(warnings[0], Date.now()), true);
  assert.strictEqual(isWarningActive({ status: '预警解除' }, Date.now()), false);
  assert.strictEqual(isWarningActive({
    endTime: '2099-08-07T12:00:00+08:00',
    raw: { messageType: { code: 'cancel' } }
  }, Date.now()), false);

  assert.ok(requests.every((request) => request.options.headers['X-QW-Api-Key'] === 'test-key'));
  assert.strictEqual(requests[0].options.params.location, '北京市朝阳区');
  assert.ok(requests[1].url.endsWith('/weatheralert/v1/current/39.9219/116.4436'));
  assert.strictEqual(requests[1].options.params.lang, 'zh');

  console.log('weatherAlertProvider.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

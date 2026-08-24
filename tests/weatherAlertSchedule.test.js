const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWeatherAlertEngine, nextScheduledScanAt, parseScanTimes } = require('../src/features/weather-alerts/engine');
const { createWeatherAlertStateStore } = require('../src/features/weather-alerts/store');

module.exports = (async () => {
  const parsed = parseScanTimes('21:00,10:00,10:00,9:60,10:00');
  assert.deepStrictEqual(parsed.map((item) => item.key), [600, 1260]);

  const at09 = Date.parse('2026-08-24T09:30:00+08:00');
  assert.strictEqual(nextScheduledScanAt(at09, undefined, 'Asia/Shanghai'), Date.parse('2026-08-24T10:00:00+08:00'));
  const at10 = Date.parse('2026-08-24T10:00:00+08:00');
  assert.strictEqual(nextScheduledScanAt(at10, undefined, 'Asia/Shanghai', true), at10);
  assert.strictEqual(nextScheduledScanAt(at10, undefined, 'Asia/Shanghai'), Date.parse('2026-08-24T21:00:00+08:00'));
  assert.strictEqual(
    nextScheduledScanAt(Date.parse('2026-08-24T21:30:00+08:00'), undefined, 'Asia/Shanghai'),
    Date.parse('2026-08-25T10:00:00+08:00')
  );

  const nowValue = Date.parse('2026-08-24T09:30:00+08:00');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-weather-alert-schedule-'));
  const store = createWeatherAlertStateStore(path.join(dir, 'state.json'), { now: () => nowValue });
  let providerCalls = 0;
  const engine = createWeatherAlertEngine({
    config: { WEATHER_ALERT_ENABLED: true, TIMEZONE: 'Asia/Shanghai' },
    provider: { getWarnings: async () => { providerCalls += 1; return []; } },
    stateStore: store,
    now: () => nowValue
  });
  assert.strictEqual(engine.start(), true);
  assert.strictEqual(store.read().runtime.nextScanAt, Date.parse('2026-08-24T10:00:00+08:00'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(providerCalls, 0, '启动不立刻扫描');
  await engine.stop();
  assert.strictEqual(store.read().runtime.nextScanAt, 0);

  console.log('weatherAlertSchedule.test.js passed');
})().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

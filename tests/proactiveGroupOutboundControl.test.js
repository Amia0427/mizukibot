const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function loadConfigValue(value) {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    if (value === undefined) {
      delete process.env.PROACTIVE_GROUP_OUTBOUND_ENABLED;
    } else {
      process.env.PROACTIVE_GROUP_OUTBOUND_ENABLED = value;
    }
    clearProjectCache();
    return require('../config').PROACTIVE_GROUP_OUTBOUND_ENABLED;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, envValue] of Object.entries(snapshot)) {
      process.env[key] = envValue;
    }
    clearProjectCache();
  }
}

const {
  DISABLED_REASON,
  buildProactiveGroupOutboundStatus,
  isProactiveGroupOutboundEnabled,
  shouldAllowProactiveGroupOutbound
} = require('../core/proactiveGroupOutboundControl');

assert.strictEqual(
  isProactiveGroupOutboundEnabled({}),
  true,
  'missing config should keep proactive group outbound enabled by default'
);
assert.strictEqual(loadConfigValue(undefined), true, 'config default should keep proactive group outbound enabled');
assert.strictEqual(loadConfigValue('true'), true, 'config should parse true as enabled');
assert.strictEqual(loadConfigValue('false'), false, 'config should parse false as disabled');
assert.strictEqual(
  isProactiveGroupOutboundEnabled({ PROACTIVE_GROUP_OUTBOUND_ENABLED: true }),
  true,
  'explicit true should enable proactive group outbound'
);
assert.strictEqual(
  isProactiveGroupOutboundEnabled({ PROACTIVE_GROUP_OUTBOUND_ENABLED: false }),
  false,
  'explicit false should disable proactive group outbound'
);

assert.deepStrictEqual(
  shouldAllowProactiveGroupOutbound({
    source: 'daily_share',
    groupId: '1001',
    runtimeConfig: { PROACTIVE_GROUP_OUTBOUND_ENABLED: false }
  }),
  {
    allowed: false,
    reason: DISABLED_REASON,
    source: 'daily_share',
    groupId: '1001'
  }
);

const status = buildProactiveGroupOutboundStatus({ PROACTIVE_GROUP_OUTBOUND_ENABLED: false });
assert.strictEqual(status.enabled, false);
assert.strictEqual(status.envKey, 'PROACTIVE_GROUP_OUTBOUND_ENABLED');
assert.strictEqual(status.defaultEnabled, true);
assert.ok(status.affectedSources.includes('tick_touch'));
assert.ok(status.affectedSources.includes('daily_share'));
assert.ok(status.affectedSources.includes('life_scheduler'));
assert.ok(status.unaffected.includes('explicit_at_bot_main_reply'));

console.log('proactiveGroupOutboundControl.test.js passed');

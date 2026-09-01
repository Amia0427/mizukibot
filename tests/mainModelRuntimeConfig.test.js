const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

function pickFrom(values = {}) {
  return (key, fallback = '') => Object.prototype.hasOwnProperty.call(values, key)
    ? values[key]
    : fallback;
}

function buildRuntimeConfig(values) {
  return require('../config/mainModelRuntime').buildMainModelRuntimeConfig({
    pick: pickFrom(values),
    env: values
  });
}

try {
  const complete = buildRuntimeConfig({
    MAIN_MODEL_1_API_BASE_URL: 'https://one.example/v1/chat/completions',
    MAIN_MODEL_1_API_KEY: 'test-key-1',
    MAIN_MODEL_1_MODEL: 'model-one',
    MAIN_MODEL_1_API_PROVIDER: 'openai_compatible',
    MAIN_MODEL_1_WEIGHT: '3',
    MAIN_MODEL_2_API_BASE_URL: 'https://two.example/v1/messages',
    MAIN_MODEL_2_API_KEY: 'test-key-2',
    MAIN_MODEL_2_MODEL: 'model-two',
    MAIN_MODEL_2_API_PROVIDER: 'anthropic',
    MAIN_MODEL_2_WEIGHT: '1',
    MAIN_MODEL_5_API_BASE_URL: 'https://five.example/v1/chat/completions',
    MAIN_MODEL_5_API_KEY: 'test-key-5',
    MAIN_MODEL_5_MODEL: 'model-five',
    MAIN_MODEL_5_WEIGHT: '2',
    MAIN_MODEL_9_API_BASE_URL: 'https://nine.example/v1/chat/completions',
    MAIN_MODEL_9_API_KEY: 'test-key-9',
    MAIN_MODEL_9_MODEL: 'model-nine',
    MAIN_MODEL_9_WEIGHT: '0',
    MAIN_MODEL_X_API_BASE_URL: 'https://invalid.example/v1/chat/completions',
    MAIN_MODEL_0_API_KEY: 'invalid-slot-zero-key',
    MAIN_MODEL_10_OTHER: 'ignored'
  });
  assert.strictEqual(complete.MAIN_MODEL_POOL_CONFIGURED, true);
  assert.deepStrictEqual(complete.MAIN_MODEL_CONFIGS.map((item) => item.slot), [1, 2, 5, 9]);
  assert.strictEqual(complete.MAIN_MODEL_CONFIGS[1].provider, 'anthropic');
  assert.deepStrictEqual(complete.MAIN_MODEL_CONFIGS.map((item) => item.weight), [3, 1, 2, 1]);
  assert.strictEqual(complete.MAIN_MODEL_CONFIGS[3].provider, '');
  assert.strictEqual(complete.MAIN_MODEL_CONFIGS[2].__mainApiKeySource, 'MAIN_MODEL_5_API_KEY');

  const incomplete = buildRuntimeConfig({
    MAIN_MODEL_1_API_BASE_URL: 'https://one.example/v1/chat/completions',
    MAIN_MODEL_1_API_KEY: 'test-key-1',
    MAIN_MODEL_1_MODEL: 'model-one',
    MAIN_MODEL_1_WEIGHT: '3',
    MAIN_MODEL_2_API_BASE_URL: 'https://two.example/v1/chat/completions',
    MAIN_MODEL_2_MODEL: 'model-two',
    MAIN_MODEL_3_API_BASE_URL: 'https://three.example/v1/chat/completions',
    MAIN_MODEL_3_API_KEY: 'test-key-3',
    MAIN_MODEL_3_MODEL: 'model-three',
    MAIN_MODEL_3_WEIGHT: '0',
    MAIN_MODEL_7_API_BASE_URL: 'https://seven.example/v1/chat/completions',
    MAIN_MODEL_7_API_KEY: 'test-key-7',
    MAIN_MODEL_7_WEIGHT: 'bogus'
  });
  assert.deepStrictEqual(incomplete.MAIN_MODEL_CONFIGS.map((item) => item.slot), [1, 3]);
  assert.deepStrictEqual(incomplete.MAIN_MODEL_CONFIGS.map((item) => item.weight), [3, 1]);

  const legacy = buildRuntimeConfig({
    API_BASE_URL: 'https://legacy.example/v1/chat/completions',
    API_KEY: 'legacy-test-key',
    AI_MODEL: 'legacy-model',
    API_PROVIDER: 'openai_compatible'
  });
  assert.strictEqual(legacy.MAIN_MODEL_POOL_CONFIGURED, false);
  assert.deepStrictEqual(legacy.MAIN_MODEL_CONFIGS.map((item) => item.id), ['legacy']);
  assert.strictEqual(legacy.MAIN_MODEL_CONFIGS[0].weight, 1);

  const missingSlotOne = buildRuntimeConfig({
    API_BASE_URL: 'https://legacy.example/v1/chat/completions',
    API_KEY: 'legacy-test-key',
    AI_MODEL: 'legacy-model',
    MAIN_MODEL_5_API_BASE_URL: 'https://five.example/v1/chat/completions',
    MAIN_MODEL_5_API_KEY: 'test-key-5',
    MAIN_MODEL_5_MODEL: 'model-five',
    MAIN_MODEL_5_WEIGHT: '2'
  });
  assert.strictEqual(missingSlotOne.MAIN_MODEL_POOL_CONFIGURED, true);
  assert.deepStrictEqual(missingSlotOne.MAIN_MODEL_CONFIGS.map((item) => item.id), ['legacy', 'slot_5']);
  assert.deepStrictEqual(missingSlotOne.MAIN_MODEL_CONFIGS.map((item) => item.weight), [1, 2]);
  assert.strictEqual(missingSlotOne.MAIN_MODEL_CONFIGS[0].__mainApiKeySource, 'API_KEY');

  const snapshot = { ...process.env };
  try {
    process.env.MIZUKIBOT_ENV_FILE = path.join(__dirname, '.main-model-runtime-missing.env');
    for (const key of Object.keys(process.env)) {
      if (/^MAIN_MODEL_\d+_(?:API_BASE_URL|API_KEY|MODEL|API_PROVIDER|WEIGHT)$/.test(key)) {
        delete process.env[key];
      }
    }
    process.env.API_BASE_URL = 'https://env.example/v1/chat/completions';
    process.env.API_KEY = 'env-test-key';
    process.env.AI_MODEL = 'env-model';
    process.env.MAIN_MODEL_1_API_BASE_URL = 'https://env-one.example/v1/chat/completions';
    process.env.MAIN_MODEL_1_API_KEY = 'env-slot-test-key';
    process.env.MAIN_MODEL_1_MODEL = 'env-slot-model';
    process.env.MAIN_MODEL_1_API_PROVIDER = 'openai_compatible';
    process.env.MAIN_MODEL_1_WEIGHT = '3';
    clearProjectCache();
    const runtimeConfig = require('../config');
    assert.strictEqual(runtimeConfig.MAIN_MODEL_CONFIGS.length, 1);
    assert.strictEqual(runtimeConfig.MAIN_MODEL_CONFIGS[0].model, 'env-slot-model');
    assert.strictEqual(runtimeConfig.MAIN_MODEL_CONFIGS[0].apiBaseUrl, 'https://env-one.example/v1/chat/completions');
    assert.strictEqual(runtimeConfig.MAIN_MODEL_CONFIGS[0].weight, 3);
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }

  console.log('mainModelRuntimeConfig.test.js passed');
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}

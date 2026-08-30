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

try {
  const { buildMainModelRuntimeConfig } = require('../config/mainModelRuntime');
  const complete = buildMainModelRuntimeConfig({
    pick: pickFrom({
      MAIN_MODEL_1_API_BASE_URL: 'https://one.example/v1/chat/completions',
      MAIN_MODEL_1_API_KEY: 'test-key-1',
      MAIN_MODEL_1_MODEL: 'model-one',
      MAIN_MODEL_1_API_PROVIDER: 'openai_compatible',
      MAIN_MODEL_2_API_BASE_URL: 'https://two.example/v1/messages',
      MAIN_MODEL_2_API_KEY: 'test-key-2',
      MAIN_MODEL_2_MODEL: 'model-two',
      MAIN_MODEL_2_API_PROVIDER: 'anthropic',
      MAIN_MODEL_3_API_BASE_URL: 'https://three.example/v1/chat/completions',
      MAIN_MODEL_3_API_KEY: 'test-key-3',
      MAIN_MODEL_3_MODEL: 'model-three',
      MAIN_MODEL_4_API_BASE_URL: 'https://four.example/v1/chat/completions',
      MAIN_MODEL_4_API_KEY: 'test-key-4',
      MAIN_MODEL_4_MODEL: 'model-four'
    })
  });
  assert.strictEqual(complete.MAIN_MODEL_POOL_CONFIGURED, true);
  assert.deepStrictEqual(complete.MAIN_MODEL_CONFIGS.map((item) => item.slot), [1, 2, 3, 4]);
  assert.strictEqual(complete.MAIN_MODEL_CONFIGS[1].provider, 'anthropic');
  assert.strictEqual(complete.MAIN_MODEL_CONFIGS[3].provider, '');
  assert.strictEqual(complete.MAIN_MODEL_CONFIGS[2].__mainApiKeySource, 'MAIN_MODEL_3_API_KEY');

  const incomplete = buildMainModelRuntimeConfig({
    pick: pickFrom({
      MAIN_MODEL_1_API_BASE_URL: 'https://one.example/v1/chat/completions',
      MAIN_MODEL_1_API_KEY: 'test-key-1',
      MAIN_MODEL_1_MODEL: 'model-one',
      MAIN_MODEL_2_API_BASE_URL: 'https://two.example/v1/chat/completions',
      MAIN_MODEL_2_MODEL: 'model-two',
      MAIN_MODEL_3_API_BASE_URL: 'https://three.example/v1/chat/completions',
      MAIN_MODEL_3_API_KEY: 'test-key-3',
      MAIN_MODEL_3_MODEL: 'model-three'
    })
  });
  assert.deepStrictEqual(incomplete.MAIN_MODEL_CONFIGS.map((item) => item.slot), [1, 3]);

  const legacy = buildMainModelRuntimeConfig({
    pick: pickFrom({
      API_BASE_URL: 'https://legacy.example/v1/chat/completions',
      API_KEY: 'legacy-test-key',
      AI_MODEL: 'legacy-model',
      API_PROVIDER: 'openai_compatible'
    })
  });
  assert.strictEqual(legacy.MAIN_MODEL_POOL_CONFIGURED, false);
  assert.deepStrictEqual(legacy.MAIN_MODEL_CONFIGS.map((item) => item.id), ['legacy']);

  const missingSlotOne = buildMainModelRuntimeConfig({
    pick: pickFrom({
      API_BASE_URL: 'https://legacy.example/v1/chat/completions',
      API_KEY: 'legacy-test-key',
      AI_MODEL: 'legacy-model',
      MAIN_MODEL_2_API_BASE_URL: 'https://two.example/v1/chat/completions',
      MAIN_MODEL_2_API_KEY: 'test-key-2',
      MAIN_MODEL_2_MODEL: 'model-two'
    })
  });
  assert.strictEqual(missingSlotOne.MAIN_MODEL_POOL_CONFIGURED, true);
  assert.deepStrictEqual(missingSlotOne.MAIN_MODEL_CONFIGS.map((item) => item.id), ['legacy', 'slot_2']);
  assert.strictEqual(missingSlotOne.MAIN_MODEL_CONFIGS[0].__mainApiKeySource, 'API_KEY');

  const snapshot = { ...process.env };
  try {
    for (let slot = 1; slot <= 4; slot += 1) {
      delete process.env[`MAIN_MODEL_${slot}_API_BASE_URL`];
      delete process.env[`MAIN_MODEL_${slot}_API_KEY`];
      delete process.env[`MAIN_MODEL_${slot}_MODEL`];
      delete process.env[`MAIN_MODEL_${slot}_API_PROVIDER`];
    }
    process.env.API_BASE_URL = 'https://env.example/v1/chat/completions';
    process.env.API_KEY = 'env-test-key';
    process.env.AI_MODEL = 'env-model';
    process.env.MAIN_MODEL_1_API_BASE_URL = 'https://env-one.example/v1/chat/completions';
    process.env.MAIN_MODEL_1_API_KEY = 'env-slot-test-key';
    process.env.MAIN_MODEL_1_MODEL = 'env-slot-model';
    process.env.MAIN_MODEL_1_API_PROVIDER = 'openai_compatible';
    clearProjectCache();
    const runtimeConfig = require('../config');
    assert.strictEqual(runtimeConfig.MAIN_MODEL_CONFIGS.length, 1);
    assert.strictEqual(runtimeConfig.MAIN_MODEL_CONFIGS[0].model, 'env-slot-model');
    assert.strictEqual(runtimeConfig.MAIN_MODEL_CONFIGS[0].apiBaseUrl, 'https://env-one.example/v1/chat/completions');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }

  console.log('mainModelRuntimeConfig.test.js passed');
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}

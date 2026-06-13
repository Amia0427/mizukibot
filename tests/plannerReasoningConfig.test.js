const assert = require('assert');

const { buildPlannerRuntimeConfig } = require('../config/plannerRuntime');

function createEnvPicker(env = {}) {
  return function pick(key, fallback) {
    const value = env[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
  };
}

function pickNum(_key, fallback) {
  return fallback;
}

function createNumPicker(env = {}) {
  return function pickNumFromEnv(key, fallback) {
    const value = env[key];
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
}

function pickBool(_key, fallback = false) {
  return fallback;
}

const defaults = buildPlannerRuntimeConfig({
  pick: createEnvPicker(),
  pickNum,
  pickBool
});

assert.strictEqual(defaults.PLAN_REASONING_EFFORT, 'off');
assert.strictEqual(defaults.PLANNER_REQUEST_TIMEOUT_MS, 15000);

const legacyOverride = buildPlannerRuntimeConfig({
  pick: createEnvPicker({ PLANNER_REASONING_EFFORT: 'low' }),
  pickNum,
  pickBool
});

assert.strictEqual(legacyOverride.PLAN_REASONING_EFFORT, 'low');

const primaryOverride = buildPlannerRuntimeConfig({
  pick: createEnvPicker({
    PLAN_REASONING_EFFORT: 'medium',
    PLANNER_REASONING_EFFORT: 'low'
  }),
  pickNum,
  pickBool
});

assert.strictEqual(primaryOverride.PLAN_REASONING_EFFORT, 'medium');

const timeoutOverride = buildPlannerRuntimeConfig({
  pick: createEnvPicker(),
  pickNum: createNumPicker({ PLANNER_REQUEST_TIMEOUT_MS: '45000' }),
  pickBool
});

assert.strictEqual(timeoutOverride.PLANNER_REQUEST_TIMEOUT_MS, 15000);

const timeoutMinimum = buildPlannerRuntimeConfig({
  pick: createEnvPicker(),
  pickNum: createNumPicker({ PLANNER_REQUEST_TIMEOUT_MS: '500' }),
  pickBool
});

assert.strictEqual(timeoutMinimum.PLANNER_REQUEST_TIMEOUT_MS, 1000);

console.log('plannerReasoningConfig.test.js passed');

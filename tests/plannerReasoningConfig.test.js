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

function pickBool(_key, fallback = false) {
  return fallback;
}

const defaults = buildPlannerRuntimeConfig({
  pick: createEnvPicker(),
  pickNum,
  pickBool
});

assert.strictEqual(defaults.PLAN_REASONING_EFFORT, 'off');

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

console.log('plannerReasoningConfig.test.js passed');

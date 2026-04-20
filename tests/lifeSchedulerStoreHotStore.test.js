const assert = require('assert');
const fs = require('fs');
const os = require('os');
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
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-life-store-'));
  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDir;
    process.env.LIFE_SCHEDULER_STATE_FILE = path.join(tempDir, 'life_state.json');
    process.env.LIFE_SCHEDULER_TARGETS_FILE = path.join(tempDir, 'life_targets.json');
    clearProjectCache();

    const {
      loadLifeState,
      saveLifeState,
      loadLifeTargets,
      saveLifeTargets
    } = require('../core/lifeSchedulerStore');

    const state = loadLifeState();
    state.settings.scheduleTime = '07:30';
    saveLifeState(state);

    const targets = loadLifeTargets();
    targets['g1'] = { enabled: true, updatedAt: new Date().toISOString() };
    saveLifeTargets(targets);
    const reloadedState = loadLifeState();
    const reloadedTargets = loadLifeTargets();
    assert.strictEqual(reloadedState.settings.scheduleTime, '07:30');
    assert.strictEqual(Boolean(reloadedTargets.g1?.enabled), true);

    console.log('lifeSchedulerStoreHotStore.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

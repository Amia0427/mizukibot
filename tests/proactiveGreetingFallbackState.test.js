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
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-proactive-fallback-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.TIMEZONE = 'Asia/Shanghai';
    process.env.PROACTIVE_GREETING_FALLBACK_ENABLED = 'true';
    process.env.PROACTIVE_GREETING_MORNING_FALLBACK_AT = '11:40';
    process.env.PROACTIVE_REPLY_ENABLED = 'true';
    process.env.PROACTIVE_REPLY_MIN_POINTS = '150';
    process.env.SCHEDULED_GREETING_MIN_POINTS = '250';
    process.env.INITIATIVE_POLICY_ENABLED = 'true';
    process.env.INITIATIVE_DECISION_ENABLED = 'true';
    process.env.INITIATIVE_DECISION_API_BASE_URL = '';
    process.env.INITIATIVE_DECISION_API_KEY = '';
    process.env.INITIATIVE_DECISION_MODEL = '';

    clearProjectCache();

    const memory = require('../utils/memory');
    memory.favorites['u-fallback'] = {
      points: 999,
      group_id: 'g-fallback',
      last_seen_at: Date.now() - (5 * 60 * 60 * 1000)
    };

    const personaMemory = require('../utils/personaMemoryState');
    const originalRecord = personaMemory.recordPersonaMemoryOutcome;
    const recordedPayloads = [];
    personaMemory.recordPersonaMemoryOutcome = async (surface, payload) => {
      recordedPayloads.push({ surface, payload });
      return { ok: true };
    };

    const { runGreetingFallbacks } = require('../core/tickEngine');

    const sentPackets = [];
    const ws = {
      send(payload) {
        sentPackets.push(JSON.parse(payload));
      }
    };

    const state = {};
    const testDate = new Date('2026-04-17T11:45:00+08:00');
    const sent = await runGreetingFallbacks(ws, async () => {
      throw new Error('should not call reply model in fallback branch');
    }, state, testDate);

    assert.strictEqual(sent, true);
    assert.strictEqual(sentPackets.length, 1);
    assert.ok(String(sentPackets[0].params.message || '').includes('早呀，今天也慢慢来。'));
    assert.strictEqual(recordedPayloads.length, 1);
    assert.strictEqual(recordedPayloads[0].surface, 'proactive_touch');
    assert.strictEqual(recordedPayloads[0].payload.state, null);
    assert.strictEqual(state['u-fallback'].last_morning_fallback_day, '2026-04-17');
    assert.strictEqual(state['u-fallback'].proactive_count, 1);

    personaMemory.recordPersonaMemoryOutcome = originalRecord;

    console.log('proactiveGreetingFallbackState.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

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

function applyTickEnv(tempDir) {
  process.env.API_KEY = process.env.API_KEY || 'test-key';
  process.env.DATA_DIR = tempDir;
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
}

async function runScenario({ wsSend, recordSystemGroupSend, recordPersonaMemoryOutcome }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-tick-send-failure-'));
  try {
    applyTickEnv(tempDir);
    clearProjectCache();

    const memory = require('../utils/memory');
    memory.favorites['u-send-failure'] = {
      points: 999,
      group_id: 'g-send-failure',
      last_seen_at: Date.now() - (5 * 60 * 60 * 1000)
    };

    const personaMemory = require('../utils/personaMemoryState');
    const recordedOutcomes = [];
    personaMemory.recordPersonaMemoryOutcome = async (surface, payload) => {
      recordedOutcomes.push({ surface, payload });
      if (recordPersonaMemoryOutcome) return recordPersonaMemoryOutcome(surface, payload);
      return { ok: true };
    };

    const systemGroupReply = require('../core/systemGroupReply');
    const systemRecords = [];
    systemGroupReply.recordSystemGroupSend = (payload) => {
      systemRecords.push(payload);
      if (recordSystemGroupSend) return recordSystemGroupSend(payload);
      return undefined;
    };

    const { runGreetingFallbacks } = require('../core/tickEngine');
    const state = {};
    const sent = await runGreetingFallbacks({ send: wsSend }, async () => {
      throw new Error('reply model should not be called for fallback greeting');
    }, state, new Date('2026-04-17T11:45:00+08:00'));

    return { sent, state, recordedOutcomes, systemRecords };
  } finally {
    clearProjectCache();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const originalError = console.error;
  console.error = () => {};

  try {
    const wsFailure = await runScenario({
      wsSend() {
        throw new Error('ws closed');
      }
    });

    assert.strictEqual(wsFailure.sent, false);
    assert.deepStrictEqual(wsFailure.state, {});
    assert.strictEqual(wsFailure.systemRecords.length, 0);
    assert.strictEqual(wsFailure.recordedOutcomes.length, 1);
    assert.strictEqual(wsFailure.recordedOutcomes[0].surface, 'touch_failed');
    assert.match(wsFailure.recordedOutcomes[0].payload.reason, /ws closed/);

    const recordFailure = await runScenario({
      wsSend() {},
      recordSystemGroupSend() {
        throw new Error('state write failed');
      }
    });

    assert.strictEqual(recordFailure.sent, false);
    assert.deepStrictEqual(recordFailure.state, {});
    assert.strictEqual(recordFailure.systemRecords.length, 1);
    assert.strictEqual(recordFailure.recordedOutcomes.length, 1);
    assert.strictEqual(recordFailure.recordedOutcomes[0].surface, 'touch_failed');
    assert.match(recordFailure.recordedOutcomes[0].payload.reason, /state write failed/);

    const memoryRecordFailure = await runScenario({
      wsSend() {},
      recordPersonaMemoryOutcome(surface) {
        if (surface === 'proactive_touch') {
          throw new Error('memory outcome failed');
        }
        return { ok: true };
      }
    });

    assert.strictEqual(memoryRecordFailure.sent, false);
    assert.deepStrictEqual(memoryRecordFailure.state, {});
    assert.strictEqual(memoryRecordFailure.systemRecords.length, 1);
    assert.strictEqual(memoryRecordFailure.recordedOutcomes.length, 2);
    assert.strictEqual(memoryRecordFailure.recordedOutcomes[0].surface, 'proactive_touch');
    assert.strictEqual(memoryRecordFailure.recordedOutcomes[1].surface, 'touch_failed');
    assert.match(memoryRecordFailure.recordedOutcomes[1].payload.reason, /memory outcome failed/);

    console.log('tickEngineSendFailure.test.js passed');
  } finally {
    console.error = originalError;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

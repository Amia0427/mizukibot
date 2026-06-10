const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-dailyshare-failure-'));
process.env.DATA_DIR = tempRoot;
process.env.DAILY_SHARE_STATE_FILE = path.join(tempRoot, 'daily_share_state.json');
process.env.DAILY_SHARE_TARGETS_FILE = path.join(tempRoot, 'daily_share_targets.json');
process.env.QZONE_GENERATION_HISTORY_FILE = path.join(tempRoot, 'qzone_generation_history.json');
process.env.DAILY_SHARE_EVENT_LOG_FILE = path.join(tempRoot, 'daily_share_events.jsonl');
process.env.DAILY_SHARE_ENABLED = 'true';
process.env.DAILY_SHARE_QZONE_ENABLED = 'true';
process.env.DAILY_SHARE_FAILURE_COOLDOWN_MINUTES = '30';
process.env.API_KEY = process.env.API_KEY || 'test-key';

const { createDailyShareEngine } = require('../core/dailyShareEngine');
const { QZONE_TARGET_ID, loadState } = require('../core/dailyShareStore');
const { formatDateInTz } = require('../utils/time');
const config = require('../config');

module.exports = (async () => {
  const engine = createDailyShareEngine({
    qzonePublisher: async (payload) => ({ ok: true, content: payload.hint || payload.content || '', reason: 'ok', source: 'test' }),
    runMemoryCli: async () => ({ ok: false }),
    recordMemoryScope: () => {},
    memoryQueryPlanner: async () => ({ query: 'qzone mood' })
  });

  const runDate = new Date('2026-04-16T23:03:31+08:00');
  const result = await engine.runDailyShareCycle({
    sendWithRetry: async () => true,
    askAIByGraph: async () => {
      throw new Error('Tool error: tool call markup was returned without executing any tool.');
    },
    date: runDate
  });

  assert.strictEqual(result.ran, true);

  const state = loadState(formatDateInTz(runDate, config.TIMEZONE));
  const qzoneState = state[QZONE_TARGET_ID];
  assert.ok(qzoneState);
  const nightSchedule = qzoneState.scheduleByWindow.night;
  const nightStatus = qzoneState.windowStatus.night;
  assert.ok(nightSchedule.cooldownUntil > runDate.getTime());
  assert.strictEqual(nightStatus.status, 'failed');
  assert.match(String(nightStatus.lastReason || ''), /tool call markup/i);

  console.log('dailyShareFailureCooldown.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

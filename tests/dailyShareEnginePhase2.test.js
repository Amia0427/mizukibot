const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-dailyshare-phase2-'));
process.env.DATA_DIR = tempRoot;
process.env.DAILY_SHARE_STATE_FILE = path.join(tempRoot, 'daily_share_state.json');
process.env.DAILY_SHARE_TARGETS_FILE = path.join(tempRoot, 'daily_share_targets.json');
process.env.QZONE_GENERATION_HISTORY_FILE = path.join(tempRoot, 'qzone_generation_history.json');
process.env.QZONE_GENERATION_LOG_FILE = path.join(tempRoot, 'qzone_generation_log.json');
process.env.QZONE_VISUAL_HISTORY_FILE = path.join(tempRoot, 'qzone_visual_history.json');
process.env.DAILY_SHARE_QZONE_ENABLED = 'true';
process.env.API_KEY = process.env.API_KEY || 'test-key';

const { createDailyShareEngine } = require('../core/dailyShareEngine');

(async () => {
  const engine = createDailyShareEngine({
    qzonePublisher: async () => ({ success: true, reason: 'ok', source: 'test' }),
    runMemoryCli: async () => ({ ok: false }),
    recordMemoryScope: () => {},
    memoryQueryPlanner: async () => ({ query: 'qzone mood' })
  });

  const debugResult = await engine.handleAdminCommand({
    rawText: '/dailyshare qzone debug',
    groupId: 'g1',
    userId: '1960901788',
    sendWithRetry: async () => true,
    askAIByGraph: async () => '',
    date: new Date('2026-04-15T22:10:00+08:00')
  });
  assert.strictEqual(debugResult.handled, true);
  assert.ok(String(debugResult.replyText).includes('QZone') || String(debugResult.replyText).includes('最近'));

  const summaryResult = await engine.handleAdminCommand({
    rawText: '/dailyshare qzone summary',
    groupId: 'g1',
    userId: '1960901788',
    sendWithRetry: async () => true,
    askAIByGraph: async () => '',
    date: new Date('2026-04-15T22:10:00+08:00')
  });
  assert.strictEqual(summaryResult.handled, true);
  assert.ok(String(summaryResult.replyText).includes('QZone phase2') || String(summaryResult.replyText).includes('最近'));

  console.log('dailyShareEnginePhase2.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-proactive-outbound-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDir;
    process.env.PROACTIVE_GROUP_OUTBOUND_ENABLED = 'false';
    process.env.DAILY_SHARE_ENABLED = 'true';
    process.env.DAILY_SHARE_QZONE_ENABLED = 'false';
    process.env.DAILY_SHARE_ALWAYS_ON_GROUPS = 'group-1';
    process.env.DAILY_SHARE_TARGETS_FILE = path.join(tempDir, 'daily_share_targets.json');
    process.env.DAILY_SHARE_STATE_FILE = path.join(tempDir, 'daily_share_state.json');
    process.env.DAILY_SHARE_EVENT_LOG_FILE = path.join(tempDir, 'daily_share_events.jsonl');
    process.env.QZONE_GENERATION_HISTORY_FILE = path.join(tempDir, 'qzone_generation_history.json');
    clearProjectCache();

    const { DISABLED_REASON } = require('../core/proactiveGroupOutboundControl');
    const { sendTouchMessage } = require('../core/tickEngine');

    let actionCalls = 0;
    let replyCalls = 0;
    const touchResult = await sendTouchMessage({
      actionClient: {
        callAction: async () => {
          actionCalls += 1;
        }
      },
      askAIByGraph: async () => {
        replyCalls += 1;
        return '不该生成';
      },
      userId: 'user-1',
      data: {
        group_id: 'group-1',
        points: 999
      },
      userState: {},
      today: '2026-07-07',
      promptPayload: {
        touchReason: 'light_care_ping',
        primaryContext: 'test'
      },
      source: 'tick_touch',
      now: Date.parse('2026-07-07T10:00:00+08:00')
    });

    assert.strictEqual(touchResult.sent, false);
    assert.strictEqual(touchResult.reason, DISABLED_REASON);
    assert.strictEqual(actionCalls, 0);
    assert.strictEqual(replyCalls, 0);

    writeJson(process.env.DAILY_SHARE_TARGETS_FILE, {
      'group-1': {
        enabled: true,
        windows: {
          morning: '08:00-10:00',
          afternoon: '13:00-15:00',
          night: '20:00-22:00'
        },
        sequences: {
          morning: ['greeting'],
          afternoon: ['knowledge'],
          night: ['mood']
        },
        maxPerDay: 3,
        minSilenceMinutes: 1,
        deferMinutes: 1
      }
    });

    const { createDailyShareEngine } = require('../core/dailyShareEngine');
    const dailyShareEngine = createDailyShareEngine({
      contentBuilder: {
        build: async () => {
          throw new Error('content builder should not run when group outbound is disabled');
        }
      }
    });

    let sendWithRetryCalls = 0;
    const dailyShareResult = await dailyShareEngine.runDailyShareCycle({
      sendWithRetry: async () => {
        sendWithRetryCalls += 1;
        return true;
      },
      askAIByGraph: async () => {
        throw new Error('reply model should not run when group outbound is disabled');
      },
      date: new Date('2026-07-07T08:30:00+08:00')
    });

    assert.strictEqual(dailyShareResult.ran, true);
    assert.strictEqual(dailyShareResult.groupOutbound.skipped, true);
    assert.strictEqual(dailyShareResult.groupOutbound.reason, DISABLED_REASON);
    assert.strictEqual(sendWithRetryCalls, 0);

    console.log('proactiveGroupOutboundEntrypoints.test.js passed');
  } finally {
    for (const listener of process.listeners('exit')) {
      if (listener && listener.name === 'flushAllSync') {
        process.removeListener('exit', listener);
      }
    }
    restoreEnv(snapshot);
    clearProjectCache();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

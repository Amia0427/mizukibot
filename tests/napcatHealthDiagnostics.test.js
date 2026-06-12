const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-napcat-health-'));
process.env.DATA_DIR = tempRoot;
process.env.NAPCAT_HEALTH_STATE_FILE = path.join(tempRoot, 'napcat-health-state.json');
process.env.NAPCAT_HEALTH_EVENT_FILE = path.join(tempRoot, 'napcat-health-events.ndjson');

const {
  buildNapCatHealthDiagnostic,
  buildNapCatHealthText,
  recordNapCatConnectionState,
  recordNapCatDegradation
} = require('../utils/napcatHealthDiagnostics');

(async () => {
  const base = Date.parse('2026-06-12T10:00:00.000Z');

  recordNapCatConnectionState('offline', {
    connected: false,
    readyStateName: 'closed',
    lastDisconnectedAt: base,
    lastDisconnectReason: 'NapCat websocket closed',
    disconnectCount: 1,
    offlineMs: 0
  }, {
    now: () => base,
    mode: 'websocket',
    reason: 'NapCat websocket closed'
  });

  recordNapCatDegradation('thinking-emoji', {
    module: 'thinking-emoji',
    reason: 'napcat_offline',
    messageId: 'm1',
    connectionState: {
      connected: false,
      readyStateName: 'closed',
      lastDisconnectedAt: base,
      offlineMs: 5000
    }
  }, {
    now: () => base + 5000
  });

  recordNapCatDegradation('continuous-message reply expand', {
    module: 'continuous-message',
    reason: 'napcat_offline',
    messageId: 'm2',
    connectionState: {
      connected: false,
      readyStateName: 'closed',
      lastDisconnectedAt: base,
      offlineMs: 8000
    }
  }, {
    now: () => base + 8000
  });

  let report = buildNapCatHealthDiagnostic({
    now: () => base + 12000,
    maxEvents: 10
  });

  assert.strictEqual(report.summary.status, 'offline');
  assert.strictEqual(report.summary.offline, true);
  assert.strictEqual(report.summary.offlineMs, 12000);
  assert.strictEqual(report.summary.lastDisconnectedAt, '2026-06-12T10:00:00.000Z');
  assert.strictEqual(report.summary.recentDegradationCount, 2);
  assert.deepStrictEqual(
    report.summary.recentDegradationActions.map((item) => `${item.key}:${item.count}`),
    ['continuous-message reply expand:1', 'thinking-emoji:1']
  );
  assert.strictEqual(report.recentDegradations[0].action, 'continuous-message reply expand');
  assert.ok(buildNapCatHealthText(report).includes('napcat-health: offline'));

  recordNapCatConnectionState('online', {
    connected: true,
    readyStateName: 'open',
    lastConnectedAt: base + 30000,
    lastDisconnectedAt: base,
    disconnectCount: 1,
    offlineMs: 0
  }, {
    now: () => base + 30000,
    mode: 'websocket'
  });

  report = buildNapCatHealthDiagnostic({
    now: () => base + 35000,
    maxEvents: 10
  });

  assert.strictEqual(report.summary.status, 'online');
  assert.strictEqual(report.summary.offline, false);
  assert.strictEqual(report.summary.offlineMs, 0);
  assert.strictEqual(report.summary.lastRecoveredAt, '2026-06-12T10:00:30.000Z');
  assert.strictEqual(report.summary.recentDegradationCount, 2);

  console.log('napcatHealthDiagnostics.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

module.exports = (() => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-main-bot-stability-window-'));
  const dataDir = path.join(tempRoot, 'data');

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    writeText(
      path.join(dataDir, 'bot-daemon.log'),
      [
        '[2026-06-15 23:19:27] daemon task started',
        '[2026-06-15 23:19:28] lock present but not owned by active main bot. lock pid=29940 not running',
        '[2026-06-15 23:19:28] main bot stale lock is outside early-exit window; reset backoff. pid=29940 lock_age_ms=5326383 effective_exit_age_ms=5326383 age_source=lock_mtime heartbeat_at= window_ms=900000',
        '[2026-06-15 23:19:28] main bot early-exit state updated. reason=outside_window, previous_pid=29940, count=0, cooldown_until=',
        '[2026-06-15 23:19:28] started main bot pid=38172, stdout=D:\\waifu\\data\\bot-runtime.out.log, stderr=D:\\waifu\\data\\bot-runtime.err.log',
        '[2026-06-15 23:19:29] main bot lock acquired after daemon start. started_pid=38172, elapsed_ms=1155, lock pid=38172 name=node start_matches_lock=True cmd="C:\\Program Files\\nodejs\\node.exe" index.js ',
        '[2026-06-15 23:49:39] bot already running, skip duplicate start. lock pid=38172 name=node start_matches_lock=True cmd="C:\\Program Files\\nodejs\\node.exe" index.js ',
        '[2026-06-16 00:22:02] bot already running, skip duplicate start. lock pid=38172 name=node start_matches_lock=True cmd="C:\\Program Files\\nodejs\\node.exe" index.js ',
        '[2026-06-16 01:49:39] bot already running, skip duplicate start. lock pid=38172 name=node start_matches_lock=True cmd="C:\\Program Files\\nodejs\\node.exe" index.js ',
        '[2026-06-16 03:49:40] bot already running, skip duplicate start. lock pid=38172 name=node start_matches_lock=True cmd="C:\\Program Files\\nodejs\\node.exe" index.js '
      ].join('\n')
    );
    writeJson(path.join(dataDir, 'bot-main-runtime-state.json'), {
      schemaVersion: 'main_bot_runtime_state_v1',
      role: 'main',
      pid: 14292,
      startedAt: '2026-06-15T20:00:04.647Z',
      heartbeatAt: '2026-06-16T00:19:57.745Z',
      stage: 'heartbeat'
    });
    writeJson(path.join(dataDir, 'bot-main-restart-state.json'), {
      firstExitAt: '',
      lastExitAt: '2026-06-15T15:19:28.0760269Z',
      count: 0,
      cooldownUntil: '',
      lastPid: 29940,
      lastReason: 'outside_window'
    });

    const {
      buildMainBotStabilityWindowReport,
      buildMainBotStabilityWindowText,
      classifyWindowDaemonMessage
    } = require('../utils/mainBotStabilityWindow');
    const report = buildMainBotStabilityWindowReport({
      projectRoot: tempRoot,
      dataDir,
      now: () => Date.parse('2026-06-16T00:30:00.000Z')
    });

    assert.strictEqual(report.schemaVersion, 'main_bot_stability_window_v1');
    assert.strictEqual(report.status, 'pass');
    assert.deepStrictEqual(report.failures, []);
    assert.deepStrictEqual(report.summary.observedPids, [38172]);
    assert.strictEqual(report.summary.mainBotStarts, 1);
    assert.strictEqual(report.summary.lockHandoffs, 1);
    assert.strictEqual(report.summary.alreadyRunningChecks, 4);
    assert.strictEqual(report.summary.blockingEvents, 0);
    assert.strictEqual(report.summary.runtimePid, 14292);
    assert.strictEqual(report.summary.restartCount, 0);
    assert.strictEqual(
      classifyWindowDaemonMessage('bot already running, skip duplicate start. lock pid=38172 name=node'),
      'main_bot_already_running'
    );

    const text = buildMainBotStabilityWindowText(report);
    assert.ok(text.includes('main-bot-stability-window: pass'));
    assert.ok(text.includes('alreadyRunning=4'));
    assert.ok(text.includes('pids=38172'));

    const script = require('../scripts/verify-main-bot-stability-window');
    assert.deepStrictEqual(
      script.parseArgs(['node', 'x', '--json', '--start=2026-01-01T00:00:00+08:00', '--end', '2026-01-01T01:00:00+08:00', '--expected-pid=123']),
      {
        json: true,
        start: '2026-01-01T00:00:00+08:00',
        end: '2026-01-01T01:00:00+08:00',
        expectedPid: 123
      }
    );

    console.log('mainBotStabilityWindow.test.js passed');
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (_) {}
  }
})();

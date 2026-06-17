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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-main-bot-restart-diag-'));
  const dataDir = path.join(tempRoot, 'data');
  const now = Date.parse('2026-06-12T12:10:00.000Z');

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    writeText(path.join(tempRoot, '.mizukibot.lock'), '49136\n');
    writeJson(path.join(dataDir, 'bot-main-restart-state.json'), {
      firstExitAt: '2026-06-12T11:55:00.000Z',
      lastExitAt: '2026-06-12T12:06:57.877Z',
      count: 2,
      cooldownUntil: '2026-06-12T12:21:57.877Z',
      lastPid: 49136,
      lastReason: 'hard_exit_while_lock_owned',
      lockAgeMs: 131408,
      effectiveRuntimeMs: 120000,
      runtimeAgeSource: 'runtime_heartbeat_lifetime',
      startedAt: '2026-06-12T11:54:00.000Z',
      heartbeatAt: '2026-06-12T11:56:00.000Z',
      windowMs: 900000,
      maxRestarts: 2,
      cooldownMs: 900000
    });
    writeJson(path.join(dataDir, 'bot-main-expected-shutdown.json'), {
      pid: 111,
      reason: 'remote_restart_scheduled',
      source: 'admin_chat_command',
      recordedAt: '2026-06-12T11:59:00.000Z',
      expiresAt: '2026-06-12T12:20:00.000Z',
      consumedAt: '2026-06-12T12:01:00.000Z',
      requestId: 'req_restart',
      messageId: 'msg_restart',
      groupId: 'group_restart'
    });
    writeText(
      path.join(dataDir, 'bot-daemon.log'),
      [
        '[2026-06-12 06:55:00] lock present but not owned by active main bot. lock pid=49136 not running',
        '[2026-06-12 06:55:00] main bot early-exit state updated. reason=counted, previous_pid=49136, count=1, cooldown_until=',
        '[2026-06-12 06:55:01] archived runtime redirect log before restart. source=D:\\waifu\\data\\bot-runtime.out.log archive=D:\\waifu\\data\\bot-runtime.out.20260612-065501-001.log',
        '[2026-06-12 06:55:01] archived runtime redirect log before restart. source=D:\\waifu\\data\\bot-runtime.err.log archive=D:\\waifu\\data\\bot-runtime.err.20260612-065501-001.log',
        '[2026-06-12 06:55:02] started main bot pid=50001, stdout=D:\\waifu\\data\\bot-runtime.out.log, stderr=D:\\waifu\\data\\bot-runtime.err.log',
        '[2026-06-12 06:55:03] main bot lock acquired after daemon start. started_pid=50001, elapsed_ms=1000, lock pid=50001 name=node',
        '[2026-06-12 07:08:00] daemon task error: main bot exited repeatedly soon after startup; backoff active (reason=threshold_reached, count=2, cooldown_until=2026-06-12T12:21:57.877Z, lock pid=49136 not running)'
      ].join('\n')
    );
    writeText(
      path.join(dataDir, 'bot-main-exit-observations.jsonl'),
      JSON.stringify({
        schemaVersion: 'main_bot_exit_observation_v1',
        source: 'windows_daemon',
        event: 'daemon_stale_lock',
        observedAt: '2026-06-12T12:06:57.877Z',
        pid: 49136,
        reason: 'lock_present_not_owned',
        earlyExitReason: 'threshold_reached',
        earlyExitCount: 2,
        runtimeMs: 120000,
        ageSource: 'runtime_heartbeat_lifetime',
        heartbeatAt: '2026-06-12T11:56:00.000Z',
        startedAt: '2026-06-12T11:54:00.000Z',
        lockDiagnostics: 'lock pid=49136 not running'
      }) + '\n'
    );
    writeText(
      path.join(dataDir, 'bot-runtime.out.20260612-065501-001.log'),
      [
        '[startup] main bot initialized',
        '[fatal] unhandledRejection Error: boom'
      ].join('\n')
    );
    writeText(
      path.join(dataDir, 'bot-runtime.err.20260612-065501-001.log'),
      [
        'Error: crash evidence',
        'at directReply'
      ].join('\n')
    );
    writeText(path.join(dataDir, 'bot-runtime.out.log'), '');
    writeText(path.join(dataDir, 'bot-runtime.err.log'), '');

    const {
      buildMainBotRestartDiagnostic,
      buildMainBotRestartText,
      classifyDaemonMessage
    } = require('../utils/mainBotRestartDiagnostics');
    const report = buildMainBotRestartDiagnostic({
      projectRoot: tempRoot,
      dataDir,
      now: () => now,
      listProcesses: () => [],
      isProcessAlive: () => false,
      tailLines: 5,
      maxArchiveLogs: 1,
      maxDaemonEvents: 10
    });

    assert.strictEqual(report.schemaVersion, 'main_bot_restart_diagnostic_v1');
    assert.strictEqual(report.summary.restartCount, 2);
    assert.strictEqual(report.summary.cooldownActive, true);
    assert.strictEqual(report.summary.lockStatus, 'stale');
    assert.strictEqual(report.lock.pid, 49136);
    assert.strictEqual(report.expectedShutdown.active, false);
    assert.strictEqual(report.expectedShutdown.source, 'admin_chat_command');
    assert.strictEqual(report.expectedShutdown.consumedAt, '2026-06-12T12:01:00.000Z');
    assert.strictEqual(report.runtimeLogs.archived.stdout.length, 1);
    assert.strictEqual(report.runtimeLogs.archived.stderr.length, 1);
    assert.ok(report.runtimeLogs.archived.stderr[0].tail.some((line) => line.includes('crash evidence')));
    assert.ok(report.daemon.events.some((event) => event.type === 'early_exit_backoff_active'));
    assert.ok(report.daemon.events.some((event) => event.type === 'runtime_log_archived'));
    assert.strictEqual(report.restartState.effectiveRuntimeMs, 120000);
    assert.strictEqual(report.restartState.runtimeAgeSource, 'runtime_heartbeat_lifetime');
    assert.strictEqual(report.exitObservations.rows.length, 1);
    assert.strictEqual(report.exitObservations.rows[0].runtimeMs, 120000);
    assert.ok(report.signals.some((signal) => signal.code === 'main_bot_restart_cooldown_active'));
    assert.ok(report.signals.some((signal) => signal.code === 'main_bot_lock_stale'));
    assert.ok(report.signals.some((signal) => signal.code === 'main_bot_hard_exit_counted_by_daemon'));
    assert.ok(report.signals.some((signal) => signal.code === 'main_bot_hard_exit_observation_recorded'));
    assert.strictEqual(
      classifyDaemonMessage('main bot early-exit state updated. reason=counted, previous_pid=1, count=1'),
      'early_exit_state_updated'
    );

    const text = buildMainBotRestartText(report);
    assert.ok(text.includes('main-bot-restarts: warning'));
    assert.ok(text.includes('state: count=2'));
    assert.ok(text.includes('expected-shutdown: exists=yes active=no consumed=yes pid=111 reason=remote_restart_scheduled source=admin_chat_command'));
    assert.ok(text.includes('runtime-evidence: started=2026-06-12T11:54:00.000Z heartbeat=2026-06-12T11:56:00.000Z effectiveRuntime=2m source=runtime_heartbeat_lifetime'));
    assert.ok(text.includes('exit-observations:'));
    assert.ok(text.includes('early=threshold_reached'));
    assert.ok(text.includes('archived-stderr:'));
    assert.ok(text.includes('crash evidence'));

    const script = require('../scripts/diagnose-main-bot-restarts');
    assert.deepStrictEqual(
      script.parseArgs(['node', 'x', '--json', '--tail-lines=7', '--max-archive-logs', '3', '--max-daemon-events=4']),
      {
        json: true,
        text: false,
        tailLines: 7,
        maxArchiveLogs: 3,
        maxDaemonEvents: 4
      }
    );

    console.log('mainBotRestartDiagnostics.test.js passed');
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (_) {}
  }
})();

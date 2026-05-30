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

module.exports = (() => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-runtime-status-'));
  const dataDir = path.join(tempDir, 'data');
  const backgroundDir = path.join(dataDir, 'background_tasks');
  const postReplyDir = path.join(dataDir, 'post_reply_jobs');
  const langGraphCheckpointDir = path.join(dataDir, 'langgraph_v2_checkpoints');
  const langGraphEventDir = path.join(dataDir, 'langgraph_v2_events');
  const memoryLockFile = path.join(dataDir, 'memory-v3', 'projections', 'materialize.lock');
  const now = Date.parse('2026-05-03T00:00:00.000Z');

  try {
    process.env.DATA_DIR = dataDir;
    process.env.BACKGROUND_TASK_STORE_DIR = backgroundDir;
    process.env.POST_REPLY_QUEUE_DIR = postReplyDir;
    process.env.LANGGRAPH_V2_CHECKPOINT_DIR = langGraphCheckpointDir;
    process.env.LANGGRAPH_V2_EVENT_DIR = langGraphEventDir;
    process.env.POST_REPLY_WORKER_ENABLED = 'true';
    process.env.POST_REPLY_WORKER_INLINE = 'false';
    process.env.POST_REPLY_WORKER_STALE_PROCESSING_MS = '300000';
    process.env.MEMORY_V3_MATERIALIZE_LOCK_FILE = memoryLockFile;
    process.env.MEMORY_V3_MATERIALIZE_LOCK_STALE_MS = '600000';
    process.env.API_KEY = process.env.API_KEY || 'test-key';

    clearProjectCache();

    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.mizukibot.lock'), '111\n', 'utf8');
    fs.writeFileSync(path.join(tempDir, '.mizukibot-postreply-worker.pid'), '222\n', 'utf8');
    writeJson(path.join(backgroundDir, 'bg_running.json'), {
      id: 'bg_running',
      status: 'running',
      stage: 'running',
      session_key: 'session_1',
      executor_type: 'background_direct',
      updated_at: '2026-05-02T23:00:00.000Z',
      started_at: '2026-05-02T23:00:00.000Z',
      group_id: 'g1',
      user_id: 'u1'
    });
    writeJson(path.join(postReplyDir, 'processing', 'post_reply_1.json'), {
      jobId: 'post_reply_1',
      schemaVersion: 2,
      status: 'processing',
      phase: 'core',
      userId: 'u1',
      aggregateKey: 'core|u1|s1|g1',
      traceId: 'trace-1',
      leaseOwner: 'worker-test',
      leaseUntil: '2026-05-02T23:45:00.000Z',
      updatedAt: '2026-05-02T23:50:00.000Z'
    });
    writeJson(path.join(postReplyDir, 'queued', 'post_reply_2.json'), {
      jobId: 'post_reply_2',
      schemaVersion: 2,
      status: 'queued',
      phase: 'enrich',
      userId: 'u2',
      availableAt: '2026-05-02T23:30:00.000Z',
      updatedAt: '2026-05-02T23:30:00.000Z'
    });
    writeJson(path.join(postReplyDir, 'failed', 'post_reply_3.json'), {
      jobId: 'post_reply_3',
      schemaVersion: 2,
      status: 'failed',
      phase: 'core',
      userId: 'u3',
      lastError: '429 rate limit',
      errorClass: 'transient',
      requeueSafe: true,
      updatedAt: '2026-05-02T23:40:00.000Z'
    });
    writeJson(memoryLockFile, {
      pid: 555,
      acquiredAt: now - (20 * 60 * 1000)
    });
    writeJson(path.join(langGraphCheckpointDir, 'thread_stale.json'), {
      threadId: 'thread_stale',
      status: 'running',
      node: 'dispatch',
      updatedAt: now - (45 * 60 * 1000),
      state: {
        thread: { threadId: 'thread_stale' }
      }
    });
    writeJson(path.join(langGraphCheckpointDir, 'thread_done.json'), {
      threadId: 'thread_done',
      status: 'completed',
      node: 'persist',
      updatedAt: now - (2 * 60 * 1000),
      state: {
        thread: { threadId: 'thread_done' }
      }
    });
    writeJson(path.join(langGraphEventDir, 'thread_stale.json'), [
      { type: 'node_start', node: 'prepare', ts: now - (46 * 60 * 1000) },
      { type: 'checkpoint', node: 'dispatch', ts: now - (45 * 60 * 1000) }
    ]);

    const processes = [
      { pid: 111, ppid: 1, name: 'node.exe', commandLine: 'node index.js' },
      { pid: 222, ppid: 1, name: 'node.exe', commandLine: '"C:\\Program Files\\nodejs\\node.exe" scripts/post-reply-worker.js' },
      { pid: 333, ppid: 222, name: 'node.exe', commandLine: 'node scripts/other-worker.js' }
    ];
    const alive = new Set([111, 222, 333]);
    const { buildRuntimeStatusDiagnostic } = require('../utils/runtimeStatusDiagnostics');
    const report = buildRuntimeStatusDiagnostic({
      projectRoot: tempDir,
      now: () => now,
      listProcesses: () => processes,
      isProcessAlive: (pid) => alive.has(Number(pid)),
      langGraphV2CheckpointStaleMs: 30 * 60 * 1000
    });

    assert.strictEqual(report.schemaVersion, 'runtime_status_diagnostic_v1');
    assert.ok(report.checkedAt);
    assert.ok(Object.prototype.hasOwnProperty.call(report, 'summary'));
    assert.ok(Object.prototype.hasOwnProperty.call(report, 'components'));
    assert.ok(Array.isArray(report.signals));

    assert.strictEqual(report.summary.mainProcess.status, 'running');
    assert.strictEqual(report.summary.postReplyWorker.status, 'running');
    assert.strictEqual(report.summary.postReplyWorker.pidFileMatch, true);
    assert.strictEqual(report.summary.activeBackgroundTasks, 1);
    assert.strictEqual(report.summary.langGraphV2.checkpoints, 2);
    assert.strictEqual(report.summary.langGraphV2.events, 1);
    assert.strictEqual(report.summary.langGraphV2.activeCheckpoints, 1);
    assert.strictEqual(report.summary.langGraphV2.staleRunningCheckpoints, 1);
    assert.ok(report.summary.langGraphV2.checkpointBytes > 0);
    assert.ok(report.summary.langGraphV2.eventBytes > 0);

    assert.strictEqual(report.components.mainProcess.lockFile.pid, 111);
    assert.strictEqual(report.components.postReplyWorker.pidFile.pid, 222);
    assert.strictEqual(report.components.postReplyWorker.queue.counts.processing, 1);
    assert.strictEqual(report.components.postReplyWorker.queue.counts.queued, 1);
    assert.strictEqual(report.components.postReplyWorker.queue.failedByErrorClass.transient, 1);
    assert.strictEqual(report.components.postReplyWorker.queue.countsByPhase.core, 2);
    assert.strictEqual(report.summary.postReplyWorker.queueByPhase.enrich, 1);
    assert.strictEqual(report.summary.postReplyWorker.failedByErrorClass.transient, 1);
    assert.ok(report.summary.postReplyWorker.oldestQueuedAgeMs > 0);
    assert.ok(report.summary.postReplyWorker.oldestProcessingLeaseAgeMs > 0);
    assert.strictEqual(report.components.backgroundTasks.countsByStatus.running, 1);
    assert.strictEqual(report.components.langGraphV2Store.countsByCheckpointStatus.running, 1);
    assert.strictEqual(report.components.langGraphV2Store.countsByCheckpointStatus.completed, 1);
    assert.strictEqual(report.components.langGraphV2Store.staleRunningCheckpoints[0].threadId, 'thread_stale');
    assert.strictEqual(report.components.langGraphV2Store.latestEventFiles[0].eventCount, 2);
    assert.strictEqual(report.components.subagents, undefined);
    assert.ok(Array.isArray(report.components.lockFiles));
    assert.ok(report.components.lockFiles.some((item) => item.name === 'memoryMaterializeLock'));

    const signalCodes = report.signals.map((item) => item.code);
    assert.ok(signalCodes.includes('background_task_stale'));
    assert.ok(signalCodes.includes('post_reply_processing_stale'));
    assert.ok(signalCodes.includes('memory_materialize_lock_stale'));
    assert.ok(signalCodes.includes('langgraph_v2_checkpoint_stale'));

    assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));

    process.env.POST_REPLY_WORKER_ENABLED = 'false';
    clearProjectCache();
    const { buildRuntimeStatusDiagnostic: buildDisabledRuntimeStatusDiagnostic } = require('../utils/runtimeStatusDiagnostics');
    const disabledReport = buildDisabledRuntimeStatusDiagnostic({
      projectRoot: tempDir,
      now: () => now,
      listProcesses: () => [],
      isProcessAlive: () => false
    });
    assert.strictEqual(disabledReport.summary.postReplyWorker.status, 'disabled');
    assert.ok(!disabledReport.signals.some((item) => String(item.code || '').startsWith('post_reply_')));

    const explicitWorkerReport = buildDisabledRuntimeStatusDiagnostic({
      projectRoot: tempDir,
      now: () => now,
      listProcesses: () => processes.filter((item) => item.pid === 222),
      isProcessAlive: (pid) => Number(pid) === 222
    });
    assert.strictEqual(explicitWorkerReport.summary.postReplyWorker.status, 'running');

    console.log('runtimeStatusDiagnostics.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
})();

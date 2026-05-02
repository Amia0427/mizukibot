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
  const memoryLockFile = path.join(dataDir, 'memory-v3', 'projections', 'materialize.lock');
  const now = Date.parse('2026-05-03T00:00:00.000Z');

  try {
    process.env.DATA_DIR = dataDir;
    process.env.BACKGROUND_TASK_STORE_DIR = backgroundDir;
    process.env.POST_REPLY_QUEUE_DIR = postReplyDir;
    process.env.POST_REPLY_WORKER_ENABLED = 'true';
    process.env.POST_REPLY_WORKER_INLINE = 'false';
    process.env.POST_REPLY_WORKER_STALE_PROCESSING_MS = '300000';
    process.env.MEMORY_V3_MATERIALIZE_LOCK_FILE = memoryLockFile;
    process.env.MEMORY_V3_MATERIALIZE_LOCK_STALE_MS = '600000';
    process.env.SUBAGENT_ENABLED = 'true';
    process.env.SUBAGENT_BACKEND = 'command';
    process.env.SUBAGENT_COMMAND_MODE = 'persistent';
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
      executor_type: 'full_subagent',
      updated_at: '2026-05-02T23:00:00.000Z',
      started_at: '2026-05-02T23:00:00.000Z',
      group_id: 'g1',
      user_id: 'u1'
    });
    writeJson(path.join(postReplyDir, 'processing', 'post_reply_1.json'), {
      jobId: 'post_reply_1',
      status: 'processing',
      phase: 'core',
      userId: 'u1',
      updatedAt: '2026-05-02T23:50:00.000Z'
    });
    writeJson(memoryLockFile, {
      pid: 555,
      acquiredAt: now - (20 * 60 * 1000)
    });

    const processes = [
      { pid: 111, ppid: 1, name: 'node.exe', commandLine: 'node index.js' },
      { pid: 222, ppid: 1, name: 'node.exe', commandLine: 'node scripts/post-reply-worker.js' },
      { pid: 333, ppid: 222, name: 'node.exe', commandLine: 'node scripts/subagent-command-worker.js' }
    ];
    const alive = new Set([111, 222, 333]);
    const { buildRuntimeStatusDiagnostic } = require('../utils/runtimeStatusDiagnostics');
    const report = buildRuntimeStatusDiagnostic({
      projectRoot: tempDir,
      now: () => now,
      listProcesses: () => processes,
      isProcessAlive: (pid) => alive.has(Number(pid))
    });

    assert.strictEqual(report.schemaVersion, 'runtime_status_diagnostic_v1');
    assert.ok(report.checkedAt);
    assert.ok(Object.prototype.hasOwnProperty.call(report, 'summary'));
    assert.ok(Object.prototype.hasOwnProperty.call(report, 'components'));
    assert.ok(Array.isArray(report.signals));

    assert.strictEqual(report.summary.mainProcess.status, 'running');
    assert.strictEqual(report.summary.postReplyWorker.status, 'running');
    assert.strictEqual(report.summary.activeBackgroundTasks, 1);
    assert.strictEqual(report.summary.activeSubagentProcesses, 1);

    assert.strictEqual(report.components.mainProcess.lockFile.pid, 111);
    assert.strictEqual(report.components.postReplyWorker.pidFile.pid, 222);
    assert.strictEqual(report.components.postReplyWorker.queue.counts.processing, 1);
    assert.strictEqual(report.components.backgroundTasks.countsByStatus.running, 1);
    assert.strictEqual(report.components.subagents.processes[0].pid, 333);
    assert.ok(Array.isArray(report.components.lockFiles));
    assert.ok(report.components.lockFiles.some((item) => item.name === 'memoryMaterializeLock'));

    const signalCodes = report.signals.map((item) => item.code);
    assert.ok(signalCodes.includes('background_task_stale'));
    assert.ok(signalCodes.includes('post_reply_processing_stale'));
    assert.ok(signalCodes.includes('memory_materialize_lock_stale'));

    assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));

    console.log('runtimeStatusDiagnostics.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
})();

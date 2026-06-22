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

module.exports = (() => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-post-reply-supervisor-'));
  const pidFile = path.join(tempDir, '.mizukibot-postreply-worker.pid');
  try {
    process.env.POST_REPLY_WORKER_ENABLED = 'true';
    process.env.POST_REPLY_WORKER_INLINE = 'false';
    process.env.POST_REPLY_WORKER_SUPERVISOR_COOLDOWN_MS = '0';
    process.env.MIZUKIBOT_PROJECT_ROOT = tempDir;
    clearProjectCache();

    const { ensurePostReplyWorkerRunning, hasRunningPostReplyWorker } = require('../utils/postReplyWorkerSupervisor');
    const calls = [];
    const started = ensurePostReplyWorkerRunning({
      projectRoot: tempDir,
      pidFile,
      listProcesses: () => [],
      isProcessAlive: () => false,
      spawn(nodeExe, args, options) {
        calls.push({ nodeExe, args, options });
        return {
          pid: 4321,
          unref() {
            calls.push({ unref: true });
          }
        };
      }
    });
    assert.strictEqual(started.started, true);
    assert.strictEqual(started.pid, 4321);
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[0].args[0].endsWith(path.join('scripts', 'post-reply-worker.js')));
    assert.strictEqual(calls[0].options.cwd, tempDir);
    assert.strictEqual(calls[0].options.detached, true);
    assert.strictEqual(calls[0].options.windowsHide, true);
    assert.strictEqual(calls[0].options.env.MIZUKIBOT_RUNTIME_ROLE, 'post_reply_worker');

    const workerProcess = {
      pid: 222,
      name: 'node.exe',
      commandLine: `"${process.execPath}" "${path.join(tempDir, 'scripts', 'post-reply-worker.js')}"`
    };
    assert.strictEqual(hasRunningPostReplyWorker({
      pidFile,
      listProcesses: () => [workerProcess],
      isProcessAlive: (pid) => Number(pid) === 222
    }), true);

    fs.writeFileSync(pidFile, '222\n', 'utf8');
    const skipped = ensurePostReplyWorkerRunning({
      projectRoot: tempDir,
      pidFile,
      listProcesses: () => [workerProcess],
      isProcessAlive: (pid) => Number(pid) === 222,
      spawn() {
        throw new Error('should not spawn when worker is already running');
      }
    });
    assert.strictEqual(skipped.started, false);
    assert.strictEqual(skipped.reason, 'already_running');

    process.env.POST_REPLY_WORKER_SUPERVISOR_ENABLED = 'false';
    clearProjectCache();
    assert.strictEqual(require('../config').POST_REPLY_WORKER_SUPERVISOR_ENABLED, false);
    const { ensurePostReplyWorkerRunning: ensureSupervisorDisabled } = require('../utils/postReplyWorkerSupervisor');
    const supervisorDisabled = ensureSupervisorDisabled({
      projectRoot: tempDir,
      pidFile,
      listProcesses: () => [],
      isProcessAlive: () => false,
      spawn() {
        throw new Error('disabled supervisor should not spawn');
      }
    });
    assert.strictEqual(supervisorDisabled.started, false);
    assert.strictEqual(supervisorDisabled.reason, 'supervisor_disabled');

    process.env.POST_REPLY_WORKER_SUPERVISOR_ENABLED = 'true';
    process.env.POST_REPLY_WORKER_ENABLED = 'false';
    clearProjectCache();
    const { ensurePostReplyWorkerRunning: ensureDisabled } = require('../utils/postReplyWorkerSupervisor');
    const disabled = ensureDisabled({
      projectRoot: tempDir,
      spawn() {
        throw new Error('disabled supervisor should not spawn');
      }
    });
    assert.strictEqual(disabled.reason, 'disabled');

    console.log('postReplyWorkerSupervisor.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
})();

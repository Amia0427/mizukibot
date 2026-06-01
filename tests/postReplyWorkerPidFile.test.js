const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  acquirePostReplyWorkerSingleInstance
} = require('../utils/postReplyWorker/singleInstance');

module.exports = (async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-postreply-pid-'));
  const pidFile = path.join(tempDir, '.mizukibot-postreply-worker.pid');
  const workerScript = `
    const fs = require('fs');
    const pidFile = ${JSON.stringify(pidFile)};
    fs.writeFileSync(pidFile, String(process.pid) + '\\n', 'utf8');
    const clear = () => {
      try {
        const recorded = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (recorded === process.pid) fs.unlinkSync(pidFile);
      } catch (_) {}
    };
    process.on('exit', clear);
    setTimeout(() => process.exit(0), 600);
  `;

  const child = spawn(process.execPath, ['-e', workerScript], {
    stdio: 'ignore'
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  const recordedPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  assert.strictEqual(recordedPid, child.pid);

  const exited = new Promise((resolve) => {
    child.on('exit', () => resolve());
  });
  await exited;
  assert.strictEqual(fs.existsSync(pidFile), false);

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}

  const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-postreply-single-'));
  try {
    const guardPidFile = path.join(guardDir, '.mizukibot-postreply-worker.pid');
    const guardLockFile = path.join(guardDir, '.mizukibot-postreply-worker.lock');
    const existingWorker = {
      pid: 22222,
      ppid: 1,
      name: 'node.exe',
      commandLine: '"C:\\Program Files\\nodejs\\node.exe" scripts/post-reply-worker.js'
    };
    const duplicate = acquirePostReplyWorkerSingleInstance({
      pidFile: guardPidFile,
      lockFile: guardLockFile,
      currentPid: 33333,
      listProcesses: () => [existingWorker],
      isProcessAlive: (pid) => Number(pid) === 22222 || Number(pid) === 33333
    });

    assert.strictEqual(duplicate.acquired, false, 'duplicate launcher should not acquire worker instance');
    assert.strictEqual(duplicate.reason, 'existing_worker_process');
    assert.strictEqual(duplicate.ownerPid, 22222);
    assert.strictEqual(fs.readFileSync(guardPidFile, 'utf8').trim(), '22222');
    assert.strictEqual(fs.existsSync(guardLockFile), false, 'duplicate launcher should not create lock');

    fs.writeFileSync(guardPidFile, '44444\n', 'utf8');
    fs.writeFileSync(guardLockFile, JSON.stringify({ pid: 44444 }) + '\n', 'utf8');
    const acquired = acquirePostReplyWorkerSingleInstance({
      pidFile: guardPidFile,
      lockFile: guardLockFile,
      currentPid: 55555,
      listProcesses: () => [{
        pid: 44444,
        ppid: 1,
        name: 'node.exe',
        commandLine: 'node index.js'
      }],
      isProcessAlive: (pid) => Number(pid) === 44444 || Number(pid) === 55555
    });

    assert.strictEqual(acquired.acquired, true, 'non-worker stale owner should not block worker start');
    assert.strictEqual(acquired.ownerPid, 55555);
    assert.strictEqual(fs.readFileSync(guardPidFile, 'utf8').trim(), '55555');
    assert.ok(fs.existsSync(guardLockFile), 'acquired worker should write an instance lock');
    assert.strictEqual(acquired.cleanup(), true);
    assert.strictEqual(fs.existsSync(guardPidFile), false);
    assert.strictEqual(fs.existsSync(guardLockFile), false);
  } finally {
    try {
      fs.rmSync(guardDir, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log('postReplyWorkerPidFile.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

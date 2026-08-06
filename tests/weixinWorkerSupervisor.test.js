const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  acquireWeixinWorkerSingleInstance,
  ensureWeixinWorkerRunning,
  hasRunningWeixinWorker
} = require('../utils/weixinWorkerSupervisor');
const { getWeixinWorkerHealth } = require('../utils/weixinWorkerSupervisor');

(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-weixin-supervisor-'));
  const pidFile = path.join(tempDir, '.mizukibot-weixin-worker.pid');
  const lockFile = path.join(tempDir, '.mizukibot-weixin-worker.lock');
  try {
    const spawnCalls = [];
    const started = ensureWeixinWorkerRunning({
      enabled: true,
      supervisorEnabled: true,
      projectRoot: tempDir,
      pidFile,
      listProcesses: () => [],
      isProcessAlive: () => false,
      spawn(nodeExe, args, options) {
        spawnCalls.push({ nodeExe, args, options });
        return { pid: 4321, unref: () => spawnCalls.push({ unref: true }) };
      }
    });
    assert.strictEqual(started.started, true);
    assert.strictEqual(started.pid, 4321);
    assert.ok(spawnCalls[0].args[0].endsWith(path.join('scripts', 'weixin-worker.js')));
    assert.strictEqual(spawnCalls[0].options.cwd, tempDir);
    assert.strictEqual(spawnCalls[0].options.detached, true);
    assert.strictEqual(spawnCalls[0].options.windowsHide, true);
    assert.strictEqual(spawnCalls[0].options.env.MIZUKIBOT_RUNTIME_ROLE, 'weixin_worker');

    const workerProcess = {
      pid: 222,
      name: 'node.exe',
      commandLine: `"${process.execPath}" "${path.join(tempDir, 'scripts', 'weixin-worker.js')}"`
    };
    assert.strictEqual(hasRunningWeixinWorker({
      projectRoot: tempDir,
      pidFile,
      listProcesses: () => [workerProcess],
      isProcessAlive: (pid) => pid === 222
    }), true);

    fs.writeFileSync(pidFile, '222\n', 'utf8');
    const skipped = ensureWeixinWorkerRunning({
      enabled: true,
      supervisorEnabled: true,
      projectRoot: tempDir,
      pidFile,
      listProcesses: () => [workerProcess],
      isProcessAlive: (pid) => pid === 222,
      spawn: () => {
        throw new Error('already-running worker must not spawn');
      }
    });
    assert.strictEqual(skipped.reason, 'already_running');

    assert.strictEqual(ensureWeixinWorkerRunning({ enabled: false }).reason, 'disabled');
    assert.strictEqual(ensureWeixinWorkerRunning({
      enabled: true,
      supervisorEnabled: false
    }).reason, 'supervisor_disabled');

    fs.rmSync(pidFile, { force: true });
    const first = acquireWeixinWorkerSingleInstance({
      currentPid: 111,
      pidFile,
      lockFile,
      isProcessAlive: (pid) => pid === 111
    });
    assert.strictEqual(first.acquired, true);
    const second = acquireWeixinWorkerSingleInstance({
      currentPid: 222,
      pidFile,
      lockFile,
      isProcessAlive: (pid) => pid === 111
    });
    assert.strictEqual(second.acquired, false);
    assert.strictEqual(second.ownerPid, 111);
    assert.strictEqual(first.cleanup(), true);
    assert.strictEqual(fs.existsSync(pidFile), false);
    assert.strictEqual(fs.existsSync(lockFile), false);

    const stateFile = path.join(tempDir, 'worker-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      stage: 'heartbeat',
      heartbeatAt: '2026-08-06T00:00:00.000Z',
      pid: 321
    }));
    assert.deepStrictEqual(getWeixinWorkerHealth({
      stateFile,
      maxAgeMs: 60_000,
      now: () => Date.parse('2026-08-06T00:00:30.000Z')
    }), {
      status: 'online',
      stage: 'heartbeat',
      heartbeatAgeMs: 30_000,
      pid: 321
    });
    assert.strictEqual(getWeixinWorkerHealth({
      stateFile,
      maxAgeMs: 60_000,
      now: () => Date.parse('2026-08-06T00:02:00.000Z')
    }).status, 'degraded');

    console.log('weixinWorkerSupervisor.test.js passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();

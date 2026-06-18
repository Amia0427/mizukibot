const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function waitForOutput(child, pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for child output: ${pattern}`));
    }, timeoutMs);

    const onData = (chunk) => {
      output += String(chunk);
      if (pattern.test(output)) {
        clearTimeout(timeout);
        resolve(output);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Child exited before ready. code=${code} signal=${signal} output=${output}`));
    });
  });
}

function spawnFakeMainBotProcess(scriptPath) {
  fs.writeFileSync(scriptPath, 'console.log("fake main bot ready"); setInterval(() => {}, 1000);\n', 'utf8');
  return spawn(process.execPath, [scriptPath], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

module.exports = (async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-main-lock-'));
  const lockFile = path.join(tempRoot, '.mizukibot.lock');
  const fakeMainBotScript = path.join(tempRoot, 'index.js');
  const testDataDir = path.join(tempRoot, 'data');
  const originalTestMode = process.env.MIZUKIBOT_INDEX_TEST_MODE;
  const originalLockFile = process.env.MIZUKIBOT_LOCK_FILE;
  const originalDataDir = process.env.DATA_DIR;
  const originalApiKey = process.env.API_KEY;
  const originalExit = process.exit;
  const beforeExitListenersBeforeRequire = new Set(process.listeners('beforeExit'));
  const exitListenersBeforeRequire = new Set(process.listeners('exit'));
  const originalConsoleError = console.error;
  let fakeMainBot = null;

  try {
    process.env.MIZUKIBOT_INDEX_TEST_MODE = '1';
    process.env.MIZUKIBOT_LOCK_FILE = lockFile;
    process.env.DATA_DIR = testDataDir;
    process.env.API_KEY = process.env.API_KEY || 'test-api-key';

    const { __test } = require('../index');

    fs.writeFileSync(lockFile, `${process.pid}\n`, 'utf8');
    const cleanupSelfOwned = await __test.acquireSingleInstanceLock();
    assert.strictEqual(fs.readFileSync(lockFile, 'utf8').trim(), String(process.pid));
    cleanupSelfOwned();
    assert.strictEqual(fs.readFileSync(lockFile, 'utf8'), '');

    fakeMainBot = spawnFakeMainBotProcess(fakeMainBotScript);
    await waitForOutput(fakeMainBot, /fake main bot ready/);
    fs.writeFileSync(lockFile, `${fakeMainBot.pid}\n`, 'utf8');

    let exitCode = null;
    console.error = () => {};
    process.exit = (code) => {
      exitCode = code;
      throw new Error(`process.exit intercepted: ${code}`);
    };

    await assert.rejects(
      () => __test.acquireSingleInstanceLock(),
      /process\.exit intercepted: 1/
    );
    assert.strictEqual(exitCode, 1, 'live main bot lock should reject startup');
    assert.strictEqual(fs.readFileSync(lockFile, 'utf8').trim(), String(fakeMainBot.pid));

    console.error = originalConsoleError;
    process.exit = originalExit;

    console.log('mainBotSingleInstanceLock.test.js passed');
  } finally {
    process.exit = originalExit;
    if (typeof originalConsoleError === 'function') {
      console.error = originalConsoleError;
    }
    if (fakeMainBot && !fakeMainBot.killed) {
      fakeMainBot.kill();
    }
    if (originalTestMode === undefined) {
      delete process.env.MIZUKIBOT_INDEX_TEST_MODE;
    } else {
      process.env.MIZUKIBOT_INDEX_TEST_MODE = originalTestMode;
    }
    if (originalLockFile === undefined) {
      delete process.env.MIZUKIBOT_LOCK_FILE;
    } else {
      process.env.MIZUKIBOT_LOCK_FILE = originalLockFile;
    }
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    if (originalApiKey === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = originalApiKey;
    }
    for (const listener of process.listeners('exit')) {
      if (!exitListenersBeforeRequire.has(listener)) {
        process.removeListener('exit', listener);
      }
    }
    for (const listener of process.listeners('beforeExit')) {
      if (!beforeExitListenersBeforeRequire.has(listener)) {
        process.removeListener('beforeExit', listener);
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

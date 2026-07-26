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

function collectChildOutput(child) {
  return new Promise((resolve) => {
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('exit', (code, signal) => resolve({ code, signal, output }));
  });
}

module.exports = (async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-main-lock-'));
  const lockFile = path.join(tempRoot, 'runtime', 'main', '.mizukibot.lock');
  const fakeMainBotScript = path.join(tempRoot, 'index.js');
  const testDataDir = path.join(tempRoot, 'data');
  const originalTestMode = process.env.MIZUKIBOT_INDEX_TEST_MODE;
  const originalLockFile = process.env.MIZUKIBOT_LOCK_FILE;
  const originalMainLockFile = process.env.MIZUKIBOT_MAIN_LOCK_FILE;
  const originalDataDir = process.env.DATA_DIR;
  const originalApiKey = process.env.API_KEY;
  const originalExit = process.exit;
  const beforeExitListenersBeforeRequire = new Set(process.listeners('beforeExit'));
  const exitListenersBeforeRequire = new Set(process.listeners('exit'));
  const originalConsoleError = console.error;
  let fakeMainBot = null;

  try {
    process.env.MIZUKIBOT_INDEX_TEST_MODE = '1';
    process.env.MIZUKIBOT_MAIN_LOCK_FILE = lockFile;
    process.env.DATA_DIR = testDataDir;
    process.env.API_KEY = process.env.API_KEY || 'test-api-key';

    const { __test } = require('../index');

    assert.strictEqual(fs.existsSync(path.dirname(lockFile)), false);
    const cleanupSelfOwned = await __test.acquireSingleInstanceLock();
    assert.strictEqual(fs.readFileSync(lockFile, 'utf8').trim(), String(process.pid));
    cleanupSelfOwned();
    assert.strictEqual(fs.existsSync(lockFile), false);

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

    const raceLockFile = path.join(tempRoot, '.mizukibot-race.lock');
    const raceGateFile = path.join(tempRoot, 'race.go');
    const raceScriptDir = path.join(tempRoot, 'lock-racer');
    const raceScript = path.join(raceScriptDir, 'index.js');
    fs.mkdirSync(raceScriptDir, { recursive: true });
    fs.writeFileSync(raceLockFile, '', 'utf8');
    fs.writeFileSync(raceScript, `
      const fs = require('fs');
      const { __test } = require(${JSON.stringify(path.join(__dirname, '..', 'index.js'))});
      process.stdout.write('READY\\n');
      const timer = setInterval(() => {
        if (!fs.existsSync(process.env.RACE_GATE_FILE)) return;
        clearInterval(timer);
        __test.acquireSingleInstanceLock().then(() => {
          process.stdout.write('ACQUIRED\\n');
          setTimeout(() => process.exit(0), 500);
        }).catch((error) => {
          process.stderr.write(String(error && error.stack || error));
          process.exit(2);
        });
      }, 5);
    `, 'utf8');

    const raceEnv = {
      ...process.env,
      MIZUKIBOT_INDEX_TEST_MODE: '1',
      MIZUKIBOT_MAIN_LOCK_FILE: raceLockFile,
      RACE_GATE_FILE: raceGateFile,
      DATA_DIR: path.join(tempRoot, 'race-data'),
      API_KEY: process.env.API_KEY || 'test-api-key'
    };
    const racers = [0, 1].map(() => spawn(process.execPath, [raceScript], {
      cwd: path.join(__dirname, '..'),
      env: raceEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }));
    await Promise.all(racers.map((child) => waitForOutput(child, /READY/)));
    const raceResultsPromise = Promise.all(racers.map(collectChildOutput));
    fs.writeFileSync(raceGateFile, 'go', 'utf8');
    const raceResults = await raceResultsPromise;
    const acquiredCount = raceResults.filter((result) => /ACQUIRED/.test(result.output)).length;
    assert.strictEqual(acquiredCount, 1, `exactly one stale-lock contender must acquire the lock: ${JSON.stringify(raceResults)}`);

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
    if (originalMainLockFile === undefined) {
      delete process.env.MIZUKIBOT_MAIN_LOCK_FILE;
    } else {
      process.env.MIZUKIBOT_MAIN_LOCK_FILE = originalMainLockFile;
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

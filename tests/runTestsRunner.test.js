const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  DEFAULT_TEST_TEMP_ROOT,
  MAX_TEST_CONCURRENCY,
  SERIAL_TEST_REASONS,
  applyDefaultTestEnv,
  discoverDefaultTestFiles,
  executeTestFiles,
  isSerialTestFile,
  resolveTestConcurrency,
  terminateProcessTree
} = require('../scripts/run-tests');

const rootDir = path.resolve(__dirname, '..');

function writeFixture(directory, name, source) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

function runRunner(files, env = {}) {
  return spawnSync(process.execPath, ['scripts/run-tests.js', ...files], {
    cwd: rootDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10000
  });
}

async function runAssertions(tempDir) {
  assert.strictEqual(isSerialTestFile('tests/runTestsDefaultEnv.test.js'), true);
  assert.strictEqual(isSerialTestFile('tests/mainBotSingleInstanceLock.test.js'), true);
  assert.strictEqual(isSerialTestFile('tests/config.test.js'), false);
  assert.strictEqual(MAX_TEST_CONCURRENCY, 8);
  assert.strictEqual(resolveTestConcurrency('500'), 8);
  assert.strictEqual(resolveTestConcurrency('4'), 4);
  assert.strictEqual(resolveTestConcurrency(''), 2);
  const blankTempEnv = applyDefaultTestEnv({ TEST_TEMP_ROOT: '   ' });
  assert.strictEqual(blankTempEnv.TEST_TEMP_ROOT, DEFAULT_TEST_TEMP_ROOT);
  assert.strictEqual(blankTempEnv.TEMP, DEFAULT_TEST_TEMP_ROOT);
  assert.strictEqual(blankTempEnv.NAPCAT_HTTP_API_BASE_URL, 'http://127.0.0.1:1');
  const customTempRoot = path.join(tempDir, 'custom-test-temp');
  const customTempEnv = applyDefaultTestEnv({
    TEST_TEMP_ROOT: customTempRoot,
    NAPCAT_HTTP_API_BASE_URL: 'http://127.0.0.1:39001'
  });
  assert.strictEqual(customTempEnv.TEST_TEMP_ROOT, customTempRoot);
  assert.strictEqual(customTempEnv.TEMP, customTempRoot);
  assert.strictEqual(customTempEnv.TMP, customTempRoot);
  assert.strictEqual(customTempEnv.TMPDIR, customTempRoot);
  assert.strictEqual(customTempEnv.NAPCAT_HTTP_API_BASE_URL, 'http://127.0.0.1:39001');
  for (const [file, reason] of Object.entries(SERIAL_TEST_REASONS)) {
    assert.ok(reason.length > 0, `${file} should document its serialization reason`);
    assert.ok(fs.existsSync(path.join(rootDir, 'tests', file)), `${file} should exist`);
  }

  const fallbackTestsDir = path.join(tempDir, 'fallback-tests');
  fs.mkdirSync(fallbackTestsDir);
  const fallbackTest = writeFixture(fallbackTestsDir, 'fallback.test.js', '');
  assert.deepStrictEqual(
    discoverDefaultTestFiles(tempDir, fallbackTestsDir, { gitCommand: 'missing-git-command' }),
    [fallbackTest]
  );
  assert.deepStrictEqual(discoverDefaultTestFiles(tempDir, fallbackTestsDir), [fallbackTest]);
  assert.deepStrictEqual(discoverDefaultTestFiles(tempDir, path.join(tempDir, 'missing-tests')), []);

  const emptyRepo = path.join(tempDir, 'empty-repo');
  const emptyRepoTests = path.join(emptyRepo, 'tests');
  fs.mkdirSync(emptyRepoTests, { recursive: true });
  writeFixture(emptyRepoTests, 'untracked.test.js', '');
  const gitInit = spawnSync('git', ['init', '--quiet'], { cwd: emptyRepo, encoding: 'utf8' });
  assert.strictEqual(gitInit.status, 0, gitInit.stderr);
  assert.deepStrictEqual(discoverDefaultTestFiles(emptyRepo, emptyRepoTests), []);
  const emptyRepoScripts = path.join(emptyRepo, 'scripts');
  fs.mkdirSync(emptyRepoScripts);
  fs.copyFileSync(path.join(rootDir, 'scripts', 'run-tests.js'), path.join(emptyRepoScripts, 'run-tests.js'));
  const emptyRun = spawnSync(process.execPath, ['scripts/run-tests.js'], {
    cwd: emptyRepo,
    encoding: 'utf8'
  });
  assert.strictEqual(emptyRun.status, 1, emptyRun.stdout);
  assert.match(emptyRun.stderr, /no test files found/);

  const trackedTests = discoverDefaultTestFiles(rootDir, path.join(rootDir, 'tests'));
  assert.ok(trackedTests.length >= 500, `git discovery should include 500+ tracked tests, found ${trackedTests.length}`);
  assert.ok(trackedTests.every((file) => file.endsWith('.test.js')));

  const barrierMarker = path.join(tempDir, 'barrier-order.txt');
  const beforeBarrier = writeFixture(tempDir, 'before-barrier.test.js', `
    const fs = require('fs');
    setTimeout(() => fs.appendFileSync(${JSON.stringify(barrierMarker)}, 'before\\n'), 150);
  `);
  const serialBarrier = writeFixture(tempDir, 'runTestsDefaultEnv.test.js', `
    const assert = require('assert');
    const fs = require('fs');
    assert.strictEqual(fs.readFileSync(${JSON.stringify(barrierMarker)}, 'utf8'), 'before\\n');
    fs.appendFileSync(${JSON.stringify(barrierMarker)}, 'serial\\n');
  `);
  const afterBarrier = writeFixture(tempDir, 'after-barrier.test.js', `
    const assert = require('assert');
    const fs = require('fs');
    assert.strictEqual(fs.readFileSync(${JSON.stringify(barrierMarker)}, 'utf8'), 'before\\nserial\\n');
  `);
  const barrierResults = await executeTestFiles(
    [beforeBarrier, serialBarrier, afterBarrier],
    { concurrency: 2, timeoutMs: 2000 }
  );
  assert.ok(barrierResults.every((result) => result.ok), JSON.stringify(barrierResults));

  const killSignals = [];
  let waits = 0;
  const fakeChild = {
    pid: 123,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      killSignals.push(signal);
    }
  };
  await terminateProcessTree(fakeChild, {
    platform: 'win32',
    spawnProcess: () => ({}),
    waitForProcess: async () => ({ error: null, code: 1 }),
    waitForChildClose: async () => {
      waits += 1;
      return waits === 2;
    }
  });
  assert.deepStrictEqual(killSignals, ['SIGKILL', 'SIGKILL']);
  assert.strictEqual(waits, 2);

  const first = writeFixture(tempDir, 'parallel-a.js', `
    setTimeout(() => {
      console.log('fixture-a');
    }, 800);
  `);
  const second = writeFixture(tempDir, 'parallel-b.js', `
    setTimeout(() => {
      console.log('fixture-b');
    }, 800);
  `);

  const startedAt = Date.now();
  const parallel = runRunner([first, second], {
    TEST_CONCURRENCY: '',
    TEST_SLOW_TOP_N: '2'
  });
  const elapsedMs = Date.now() - startedAt;

  assert.strictEqual(parallel.status, 0, parallel.stderr || parallel.stdout);
  assert.ok(elapsedMs < 1300, `default concurrency should be 2, elapsed=${elapsedMs}ms`);
  assert.ok(parallel.stdout.indexOf('fixture-a') < parallel.stdout.indexOf('fixture-b'));
  assert.ok(parallel.stdout.indexOf('[test] pass parallel-a.js') < parallel.stdout.indexOf('[test] pass parallel-b.js'));
  assert.match(parallel.stdout, /\[test\] slowest 2 files/);

  const marker = path.join(tempDir, 'grandchild-survived.txt');
  const timeoutParent = writeFixture(tempDir, 'timeout-parent.js', `
    const { spawn } = require('child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(`
      const fs = require('fs');
      setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'survived'), 1000);
      setTimeout(() => {}, 5000);
    `)}], { stdio: 'ignore', windowsHide: true });
    setInterval(() => {}, 1000);
  `);

  const timedOut = runRunner([timeoutParent], {
    TEST_FILE_TIMEOUT_MS: '250'
  });
  assert.strictEqual(timedOut.status, 1, timedOut.stdout);
  assert.match(timedOut.stderr, /timed out after 250ms/);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1300);
  assert.strictEqual(fs.existsSync(marker), false, 'timeout must terminate the whole process tree');

  console.log('runTestsRunner.test.js passed');
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-test-runner-'));
  try {
    await runAssertions(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

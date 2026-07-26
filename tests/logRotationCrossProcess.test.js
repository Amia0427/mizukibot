const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-log-lock-'));
const target = path.join(tempDir, 'shared-model-calls.ndjson');
const childScript = [
  "const { appendFileWithRotation } = require('./utils/logRotation');",
  'const target=process.argv[1];',
  'const prefix=process.argv[2];',
  'for(let i=0;i<50;i+=1){',
  ' appendFileWithRotation(target, `${prefix}-${i.toString().padStart(2, "0")}-${"x".repeat(30)}\\n`, {',
  '  maxBytes: 220, maxFiles: 100, maxAgeMs: 3600000, maxTotalBytes: 10485760,',
  '  maintenanceIntervalMs: 60000, diskWarnPercent: 100, diskErrorPercent: 100,',
  '  lockTimeoutMs: 10000, lockStaleMs: 30000, lockRetryMs: 2',
  ' });',
  '}'
].join('');

function runChild(prefix) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childScript, target, prefix], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`child ${prefix} exited ${code}: ${stderr}`)));
  });
}

(async () => {
  await Promise.all([runChild('main'), runChild('worker')]);
  const files = fs.readdirSync(tempDir)
    .filter((name) => name === path.basename(target) || /^shared-model-calls\.ndjson\.\d+$/.test(name));
  const lines = files.flatMap((name) => fs.readFileSync(path.join(tempDir, name), 'utf8').trim().split(/\r?\n/).filter(Boolean));
  assert.strictEqual(lines.length, 100, 'cross-process rotation must retain every appended record');
  assert.strictEqual(new Set(lines).size, 100, 'cross-process rotation must not duplicate records');
  assert.ok(!fs.existsSync(`${target}.rotation.lock`), 'target lock must be released after all writers exit');

  const staleLock = `${target}.rotation.lock`;
  fs.mkdirSync(staleLock);
  fs.writeFileSync(path.join(staleLock, 'owner.json'), '{}');
  const staleTime = new Date(Date.now() - 60000);
  fs.utimesSync(staleLock, staleTime, staleTime);
  require('../utils/logRotation').appendFileWithRotation(target, 'stale-recovered\n', {
    maxBytes: 1048576,
    maxFiles: 100,
    lockTimeoutMs: 1000,
    lockStaleMs: 100,
    lockRetryMs: 2,
    diskWarnPercent: 100,
    diskErrorPercent: 100
  });
  assert.ok(!fs.existsSync(staleLock), 'stale target lock must be recovered and released');

  fs.mkdirSync(staleLock);
  fs.writeFileSync(path.join(staleLock, 'owner.json'), '{}');
  let observedLockFailure = null;
  assert.throws(() => {
    require('../utils/logRotation').appendFileWithRotation(target, 'must-not-write\n', {
      lockTimeoutMs: 20,
      lockStaleMs: 60000,
      lockRetryMs: 2,
      onLockFailure(error) {
        observedLockFailure = error;
      }
    });
  }, (error) => error?.code === 'LOG_ROTATION_LOCK_TIMEOUT');
  assert.strictEqual(observedLockFailure?.code, 'LOG_ROTATION_LOCK_TIMEOUT');
  fs.unlinkSync(path.join(staleLock, 'owner.json'));
  fs.rmdirSync(staleLock);

  console.log('logRotationCrossProcess.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

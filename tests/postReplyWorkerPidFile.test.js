const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

  console.log('postReplyWorkerPidFile.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

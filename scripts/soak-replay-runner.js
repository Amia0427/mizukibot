const fs = require('fs');
const path = require('path');
const config = require('../config');
const { spawn } = require('child_process');

async function runOnce(scriptPath, inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, inputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.join(__dirname, '..')
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `replay exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main() {
  const inputPath = path.resolve(String(process.argv[2] || config.FOLLOWER_NAPCAT_LOG_PATH || '').trim());
  const rounds = Math.max(1, Number(process.argv[3] || 3) || 3);
  if (!fs.existsSync(inputPath)) throw new Error(`input file not found: ${inputPath}`);

  const scriptPath = path.join(__dirname, 'replay-napcat-log.js');
  const results = [];
  for (let index = 0; index < rounds; index += 1) {
    const result = await runOnce(scriptPath, inputPath);
    results.push(result);
  }

  const p95Values = results.map((item) => Number(item.latencyP95Ms || 0));
  const rssDrift = results.length >= 2
    ? Math.max(...p95Values) - Math.min(...p95Values)
    : 0;

  console.log(JSON.stringify({
    ok: true,
    inputPath,
    rounds,
    results,
    p95DriftMs: rssDrift
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyCandidates,
  collectFootprint,
  parseArgs
} = require('../scripts/inspect-data-footprint');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-data-footprint-'));

function writeFileWithMtime(filePath, text, mtimeMs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
  const time = new Date(mtimeMs);
  fs.utimesSync(filePath, time, time);
}

try {
  const nowMs = Date.parse('2026-05-18T00:00:00.000Z');
  const oldMs = nowMs - (20 * 24 * 60 * 60 * 1000);
  const freshMs = nowMs - (2 * 24 * 60 * 60 * 1000);
  const oldCheckpoint = path.join(tempRoot, 'langgraph_v2_checkpoints', 'old.json');
  const freshCheckpoint = path.join(tempRoot, 'langgraph_v2_checkpoints', 'fresh.json');
  const oldImage = path.join(tempRoot, 'inbound_image_cache', 'old.jpg');
  const doneJob = path.join(tempRoot, 'post_reply_jobs', 'done', 'job.json');
  const largeLog = path.join(tempRoot, 'model-calls.ndjson');

  writeFileWithMtime(oldCheckpoint, 'old', oldMs);
  writeFileWithMtime(freshCheckpoint, 'fresh', freshMs);
  writeFileWithMtime(oldImage, 'image', oldMs);
  writeFileWithMtime(doneJob, 'job', oldMs);
  writeFileWithMtime(largeLog, '1234567890', freshMs);

  assert.strictEqual(parseArgs(['--apply']).apply, true);
  assert.strictEqual(parseArgs(['--max-log-mb=1']).maxLogBytes, 1024 * 1024);

  const report = collectFootprint({
    dataDir: tempRoot,
    nowMs,
    oldDays: 14,
    imageCacheDays: 7,
    doneJobDays: 7,
    maxLogBytes: 4
  });

  assert.strictEqual(report.apply, false);
  assert.ok(report.candidates.some((item) => item.category === 'old_checkpoint'));
  assert.ok(report.candidates.some((item) => item.category === 'old_inbound_image'));
  assert.ok(report.candidates.some((item) => item.category === 'old_post_reply_done_job'));
  assert.ok(report.candidates.some((item) => item.category === 'large_log'));
  assert.ok(fs.existsSync(oldCheckpoint), 'dry-run must not delete checkpoint');
  assert.ok(fs.existsSync(largeLog), 'dry-run must not delete log');

  const result = applyCandidates(report);
  assert.strictEqual(result.failedFiles, 0);
  assert.ok(result.deletedFiles >= 4);
  assert.ok(!fs.existsSync(oldCheckpoint));
  assert.ok(fs.existsSync(freshCheckpoint));

  console.log('dataFootprintInspection.test.js passed');
} finally {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (_) {}
}

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cleanupStaleDataTmpFiles } = require('../utils/dataTmpCleanup');

assert.strictEqual(cleanupStaleDataTmpFiles().ok, false);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-data-tmp-cleanup-'));
const imageCacheDir = path.join(tempRoot, 'inbound_image_cache');
const nestedDir = path.join(tempRoot, 'memory-v3', 'projections');
fs.mkdirSync(imageCacheDir, { recursive: true });
fs.mkdirSync(nestedDir, { recursive: true });

const nowMs = Date.now();
const oldMs = nowMs - (3 * 60 * 60 * 1000);
const freshMs = nowMs - (30 * 60 * 1000);

function writeFileWithMtime(filePath, text, mtimeMs) {
  fs.writeFileSync(filePath, text, 'utf8');
  const time = new Date(mtimeMs);
  fs.utimesSync(filePath, time, time);
}

const staleRootTmp = path.join(tempRoot, 'memory_index.json.123.tmp');
const staleNestedTmp = path.join(nestedDir, 'embedding_cache.jsonl.123.456.tmp');
const freshTmp = path.join(tempRoot, 'memories.json.456.tmp');
const imageCacheTmp = path.join(imageCacheDir, 'cached-image.tmp');
const normalLog = path.join(tempRoot, 'model-calls.ndjson');

writeFileWithMtime(staleRootTmp, 'old-root', oldMs);
writeFileWithMtime(staleNestedTmp, 'old-nested', oldMs);
writeFileWithMtime(freshTmp, 'fresh', freshMs);
writeFileWithMtime(imageCacheTmp, 'image-cache', oldMs);
writeFileWithMtime(normalLog, 'log', oldMs);

const summary = cleanupStaleDataTmpFiles({
  dataDir: tempRoot,
  nowMs,
  maxAgeMs: 2 * 60 * 60 * 1000,
  excludeDirs: [imageCacheDir]
});

assert.strictEqual(summary.deletedFiles, 2);
assert.strictEqual(summary.failedFiles, 0);
assert.ok(!fs.existsSync(staleRootTmp));
assert.ok(!fs.existsSync(staleNestedTmp));
assert.ok(fs.existsSync(freshTmp));
assert.ok(fs.existsSync(imageCacheTmp));
assert.ok(fs.existsSync(normalLog));

console.log('dataTmpCleanup tests passed');

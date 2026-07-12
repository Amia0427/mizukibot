const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendFileWithRotation,
  appendFileWithRotationBatched,
  flushBatchedLogWritesSync,
  inspectLogStoragePressure,
  maintainLogArchives,
  registerLogTarget,
  resetLogRotationStateForTests,
  resolveRotationOptions
} = require('../utils/logRotation');
const { createJsonLineHotWriter } = require('../utils/jsonHotStore');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-log-rotation-'));

const directFile = path.join(tempDir, 'direct.ndjson');
appendFileWithRotation(directFile, `${'a'.repeat(20)}\n`, {
  maxBytes: 30
});
appendFileWithRotation(directFile, `${'b'.repeat(20)}\n`, {
  maxBytes: 30
});

const directArchives = fs.readdirSync(tempDir).filter((name) => name.startsWith('direct.ndjson.'));
assert.strictEqual(directArchives.length, 1);
assert.ok(fs.readFileSync(path.join(tempDir, directArchives[0]), 'utf8').includes('a'));
assert.ok(fs.readFileSync(directFile, 'utf8').includes('b'));

const writerFile = path.join(tempDir, 'writer.jsonl');
const writer = createJsonLineHotWriter(writerFile, {
  debounceMs: 0,
  maxDelayMs: 0,
  rotateMaxBytes: 24
});
assert.strictEqual(writer.getMeta().retentionManaged, false, 'generic JSONL writer must not opt into retention');
writer.append({ value: 'first-long-line' });
writer.flushSync();
writer.append({ value: 'second-long-line' });
writer.flushSync();

const writerArchives = fs.readdirSync(tempDir).filter((name) => name.startsWith('writer.jsonl.'));
assert.strictEqual(writerArchives.length, 1);
assert.ok(fs.readFileSync(path.join(tempDir, writerArchives[0]), 'utf8').includes('first-long-line'));
assert.ok(fs.readFileSync(writerFile, 'utf8').includes('second-long-line'));

const registryFile = path.join(tempDir, 'registry.jsonl');
const registryWriter = require('../utils/storeRegistry').getJsonLineWriter(registryFile, {
  debounceMs: 0,
  maxDelayMs: 0,
  rotateMaxBytes: 24
});
assert.strictEqual(registryWriter.getMeta().retentionManaged, false, 'registry JSONL writer must not opt into retention');
registryWriter.append({ value: 'first-registry-line' });
registryWriter.flushSync();
registryWriter.append({ value: 'second-registry-line' });
registryWriter.flushSync();

const registryArchives = fs.readdirSync(tempDir).filter((name) => name.startsWith('registry.jsonl.'));
assert.strictEqual(registryArchives.length, 1);
assert.ok(fs.readFileSync(path.join(tempDir, registryArchives[0]), 'utf8').includes('first-registry-line'));
assert.ok(fs.readFileSync(registryFile, 'utf8').includes('second-registry-line'));

const batchedFile = path.join(tempDir, 'batched.ndjson');
appendFileWithRotationBatched(batchedFile, `${'c'.repeat(20)}\n`, {
  debounceMs: 1000,
  maxBytes: 30
});
appendFileWithRotationBatched(batchedFile, `${'d'.repeat(20)}\n`, {
  debounceMs: 1000,
  maxBytes: 30
});
flushBatchedLogWritesSync(batchedFile);

const batchedArchives = fs.readdirSync(tempDir).filter((name) => name.startsWith('batched.ndjson.'));
assert.strictEqual(batchedArchives.length, 0, 'same batch should rotate at most once before append');
assert.ok(fs.readFileSync(batchedFile, 'utf8').includes('c'));
assert.ok(fs.readFileSync(batchedFile, 'utf8').includes('d'));

assert.strictEqual(resolveRotationOptions().maxFiles, 10);
assert.ok(resolveRotationOptions().maxAgeMs > 0);
assert.ok(resolveRotationOptions().maxTotalBytes > 0);

resetLogRotationStateForTests();
const governedDir = path.join(tempDir, 'governed');
fs.mkdirSync(governedDir);
const governedFile = path.join(governedDir, 'request-trace.ndjson');
fs.writeFileSync(governedFile, 'active');
const oldArchive = `${governedFile}.1`;
const recentArchive = `${governedFile}.2`;
const timestampArchive = `${governedFile}.20260712010101001`;
fs.writeFileSync(oldArchive, 'old-archive');
fs.writeFileSync(recentArchive, 'recent-archive');
fs.writeFileSync(timestampArchive, 'timestamp-archive');
const unrelatedFiles = [
  path.join(governedDir, 'memory-events.jsonl'),
  path.join(governedDir, 'daily_journal.ndjson'),
  path.join(governedDir, 'post_reply_jobs.jsonl'),
  path.join(governedDir, 'embedding-cache.jsonl'),
  path.join(governedDir, 'profile.db-wal'),
  path.join(governedDir, 'profile.db-shm'),
  `${governedFile}.backup`,
  `${governedFile}.2026-07-12`
];
for (const file of unrelatedFiles) fs.writeFileSync(file, 'must-stay');
const nowMs = Date.UTC(2026, 6, 12, 12, 0, 0);
fs.utimesSync(oldArchive, new Date(nowMs - 5000), new Date(nowMs - 5000));
fs.utimesSync(recentArchive, new Date(nowMs - 100), new Date(nowMs - 100));
fs.utimesSync(timestampArchive, new Date(nowMs - 100), new Date(nowMs - 100));

const rejectedMaintenance = maintainLogArchives(governedFile, {
  nowMs,
  maxAgeMs: 1000,
  force: true
});
assert.strictEqual(rejectedMaintenance.reason, 'unregistered_target');
assert.ok(fs.existsSync(oldArchive));

registerLogTarget(governedFile);
const ttlMaintenance = maintainLogArchives(governedFile, {
  nowMs,
  maxAgeMs: 1000,
  maxFiles: 10,
  maxTotalBytes: 1024,
  force: true
});
assert.strictEqual(ttlMaintenance.maintained, true);
assert.ok(!fs.existsSync(oldArchive), 'expired registered archive should be removed');
assert.ok(fs.existsSync(governedFile), 'active log must never be removed');
for (const file of unrelatedFiles) assert.ok(fs.existsSync(file), `unrelated data must remain: ${file}`);

resetLogRotationStateForTests();
const familyA = path.join(governedDir, 'family-a.log');
const familyB = path.join(governedDir, 'family-b.log');
fs.writeFileSync(familyA, 'active-a');
fs.writeFileSync(familyB, 'active-b');
const familyAArchive = `${familyA}.1`;
const familyBArchive = `${familyB}.1`;
fs.writeFileSync(familyAArchive, 'a'.repeat(30));
fs.writeFileSync(familyBArchive, 'b'.repeat(30));
fs.utimesSync(familyAArchive, new Date(nowMs - 200), new Date(nowMs - 200));
fs.utimesSync(familyBArchive, new Date(nowMs - 100), new Date(nowMs - 100));
registerLogTarget(familyA);
registerLogTarget(familyB);
const capacityMaintenance = maintainLogArchives(familyB, {
  nowMs,
  maxAgeMs: 10000,
  maxFiles: 10,
  maxTotalBytes: 50,
  force: true
});
assert.strictEqual(capacityMaintenance.maintained, true);
assert.ok(fs.existsSync(familyA), 'global capacity must not remove an active target');
assert.ok(fs.existsSync(familyB), 'global capacity must not remove an active target');
assert.ok(!fs.existsSync(familyAArchive), 'oldest archive should be evicted across registered families');
assert.ok(fs.existsSync(familyBArchive), 'newest archive should remain within the shared quota');
assert.strictEqual(capacityMaintenance.directoryTargetCount, 2);
assert.strictEqual(capacityMaintenance.directoryActiveBytes, 16);
assert.strictEqual(capacityMaintenance.directoryLogBytes, 46);

const stateSourceFile = path.join(governedDir, 'memory-v3-events.jsonl');
const stateArchive = `${stateSourceFile}.1`;
fs.writeFileSync(stateSourceFile, 'active-state');
fs.writeFileSync(stateArchive, 'historical-state');
const stateWriter = createJsonLineHotWriter(stateSourceFile, { debounceMs: 0, maxDelayMs: 0 });
stateWriter.append({ type: 'memory_confirmed' });
stateWriter.flushSync();
const stateMaintenance = maintainLogArchives(stateSourceFile, {
  nowMs,
  maxAgeMs: 1,
  maxFiles: 1,
  maxTotalBytes: 1,
  force: true
});
assert.strictEqual(stateMaintenance.reason, 'unregistered_target');
assert.ok(fs.existsSync(stateArchive), 'unmanaged state-source archives must not be cleaned');

const largeStateFile = path.join(governedDir, 'daily-journal-events.jsonl');
fs.writeFileSync(largeStateFile, '');
fs.truncateSync(largeStateFile, 101 * 1024 * 1024);
const largeStateWriter = createJsonLineHotWriter(largeStateFile, { debounceMs: 0, maxDelayMs: 0 });
largeStateWriter.append({ type: 'journal_entry' });
largeStateWriter.flushSync();
assert.ok(fs.statSync(largeStateFile).size > 100 * 1024 * 1024, 'large unmanaged state source must stay at its original path');
assert.strictEqual(
  fs.readdirSync(governedDir).filter((name) => name.startsWith('daily-journal-events.jsonl.')).length,
  0,
  'large unmanaged state source must not rotate without explicit options'
);

let statfsCalls = 0;
const statfs = () => {
  statfsCalls += 1;
  return { bsize: 100, blocks: 100, bavail: 10 };
};
const pressure = inspectLogStoragePressure(governedFile, {
  nowMs,
  maintenanceIntervalMs: 1000,
  diskWarnPercent: 80,
  diskErrorPercent: 95,
  statfs,
  force: true
});
assert.strictEqual(pressure.status, 'warn');
const cachedPressure = inspectLogStoragePressure(governedFile, {
  nowMs: nowMs + 100,
  maintenanceIntervalMs: 1000,
  statfs
});
assert.strictEqual(cachedPressure.cached, true);
assert.strictEqual(statfsCalls, 1, 'disk usage check should be cached between maintenance intervals');

console.log('logRotation tests passed');

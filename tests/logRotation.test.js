const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendFileWithRotation,
  appendFileWithRotationBatched,
  flushBatchedLogWritesSync
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

console.log('logRotation tests passed');

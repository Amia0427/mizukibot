'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-v3-legacy-archive-'));
process.env.DATA_DIR = tempRoot;
process.env.PROMPTS_DIR = 'D:\\waifu\\prompts';

const fileContents = {
  'memory_items.json': '{"items":[1]}',
  'memory_index.json': '{"index":true}',
  'memory_library.json': '{"library":true}',
  'memory_projection.json': '{"projection":true}'
};
for (const [name, content] of Object.entries(fileContents)) {
  fs.writeFileSync(path.join(tempRoot, name), content, 'utf8');
}
const shardsDir = path.join(tempRoot, 'memory-shards');
fs.mkdirSync(path.join(shardsDir, 'u1'), { recursive: true });
fs.writeFileSync(path.join(shardsDir, 'u1', 'items.json'), '{"items":[2]}', 'utf8');

const {
  LEGACY_VECTOR_PATHS,
  archiveLegacyFiles,
  buildLegacyArchiveManifest,
  manifestHash,
  restoreLegacyArchive
} = require('../utils/memory-v3/legacyArchive');

const staleManifest = buildLegacyArchiveManifest({
  now: Date.parse('2026-08-04T01:00:00.000Z'),
  dataDir: tempRoot,
  targetDir: path.join(tempRoot, 'archive', 'stale-plan')
});
fs.appendFileSync(path.join(tempRoot, 'memory_items.json'), '\n', 'utf8');
assert.throws(() => archiveLegacyFiles({ manifest: staleManifest }), /source files changed/);

const targetDir = path.join(tempRoot, 'archive', 'memory-vector-legacy-test');
const manifest = buildLegacyArchiveManifest({
  now: Date.parse('2026-08-04T02:00:00.000Z'),
  dataDir: tempRoot,
  targetDir
});
assert.deepStrictEqual(manifest.entries.map((entry) => path.basename(entry.originalPath)), LEGACY_VECTOR_PATHS);
assert.strictEqual(manifest.entries.every((entry) => entry.exists && entry.sha256), true);
assert.ok(manifest.entries.find((entry) => entry.type === 'directory').size > 0);
assert.strictEqual(manifest.manifestHash, manifestHash(manifest));

const archived = archiveLegacyFiles({ manifest });
assert.strictEqual(archived.ok, true);
assert.strictEqual(archived.moved, LEGACY_VECTOR_PATHS.length);
assert.strictEqual(fs.existsSync(archived.manifestPath), true);
for (const name of LEGACY_VECTOR_PATHS) {
  assert.strictEqual(fs.existsSync(path.join(tempRoot, name)), false);
  assert.strictEqual(fs.existsSync(path.join(targetDir, name)), true);
}

const savedManifest = JSON.parse(fs.readFileSync(archived.manifestPath, 'utf8'));
assert.strictEqual(savedManifest.manifestHash, manifestHash(savedManifest));
const restored = restoreLegacyArchive(archived.manifestPath);
assert.strictEqual(restored.ok, true);
assert.strictEqual(restored.restored.length, LEGACY_VECTOR_PATHS.length);
assert.strictEqual(restored.remaining, 0);
assert.strictEqual(fs.existsSync(archived.manifestPath), true, 'rollback must retain the archive manifest');
for (const name of LEGACY_VECTOR_PATHS) {
  assert.strictEqual(fs.existsSync(path.join(tempRoot, name)), true);
}

const repeated = restoreLegacyArchive(archived.manifestPath);
assert.strictEqual(repeated.ok, true);
assert.strictEqual(repeated.restored.length, 0);
assert.strictEqual(repeated.remaining, 0);

fs.renameSync(
  path.join(tempRoot, 'memory_library.json'),
  path.join(tempRoot, 'memory_library.missing')
);
assert.throws(() => restoreLegacyArchive(archived.manifestPath), /archive entry is missing/);
fs.renameSync(
  path.join(tempRoot, 'memory_library.missing'),
  path.join(tempRoot, 'memory_library.json')
);

const tamperedTarget = path.join(tempRoot, 'archive', 'tampered-restore');
const tamperedManifest = buildLegacyArchiveManifest({
  now: Date.parse('2026-08-04T03:00:00.000Z'),
  dataDir: tempRoot,
  targetDir: tamperedTarget
});
const tamperedArchive = archiveLegacyFiles({ manifest: tamperedManifest });
fs.appendFileSync(path.join(tamperedTarget, 'memory_index.json'), 'tampered', 'utf8');
assert.throws(() => restoreLegacyArchive(tamperedArchive.manifestPath), /content hash mismatch/);
assert.strictEqual(fs.existsSync(path.join(tempRoot, 'memory_items.json')), false);
assert.strictEqual(fs.existsSync(path.join(tamperedTarget, 'memory_items.json')), true);

console.log('memoryV3LegacyArchive.test.js passed');

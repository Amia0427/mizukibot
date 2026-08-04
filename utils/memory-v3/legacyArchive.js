'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { atomicWriteJson, ensureDir, normalizeText, safeReadJson } = require('./helpers');

const LEGACY_VECTOR_PATHS = Object.freeze([
  'memory_items.json',
  'memory_index.json',
  'memory_library.json',
  'memory_projection.json',
  'memory-shards'
]);

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function inspectPath(targetPath) {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return {
      type: 'file',
      size: stat.size,
      sha256: sha256Buffer(fs.readFileSync(targetPath))
    };
  }
  const entries = fs.readdirSync(targetPath).sort().map((name) => {
    const child = inspectPath(path.join(targetPath, name));
    return { name, ...child };
  });
  return {
    type: 'directory',
    size: entries.reduce((total, entry) => total + entry.size, 0),
    sha256: sha256Buffer(Buffer.from(JSON.stringify(entries), 'utf8'))
  };
}

function sha256Path(targetPath) {
  return inspectPath(targetPath).sha256;
}

function timestampForArchive(now = Date.now()) {
  return new Date(Number(now) || Date.now()).toISOString().replace(/[:.]/g, '-');
}

function legacyPathEntries(dataDir = config.DATA_DIR, targetDir = '') {
  return LEGACY_VECTOR_PATHS.map((name) => {
    const originalPath = path.join(dataDir, name);
    const exists = fs.existsSync(originalPath);
    const inspected = exists ? inspectPath(originalPath) : null;
    const stat = exists ? fs.statSync(originalPath) : null;
    return {
      originalPath,
      archivePath: targetDir ? path.join(targetDir, name) : '',
      exists,
      type: inspected?.type || (name === 'memory-shards' ? 'directory' : 'file'),
      size: inspected?.size || 0,
      mtimeMs: stat?.mtimeMs || 0,
      sha256: inspected?.sha256 || ''
    };
  });
}

function manifestHash(value = {}) {
  const copy = { ...value };
  delete copy.manifestHash;
  return sha256Buffer(Buffer.from(JSON.stringify(copy), 'utf8'));
}

function buildLegacyArchiveManifest(options = {}) {
  const now = Number(options.now || Date.now()) || Date.now();
  const dataDir = path.resolve(options.dataDir || config.DATA_DIR);
  const targetDir = path.resolve(normalizeText(options.targetDir)
    || path.join(dataDir, 'archive', `memory-vector-legacy-${timestampForArchive(now)}`));
  const manifest = {
    version: 1,
    kind: 'memory_vector_legacy_archive',
    createdAt: new Date(now).toISOString(),
    dataDir,
    targetDir,
    manifestPath: path.join(targetDir, 'manifest.json'),
    entries: legacyPathEntries(dataDir, targetDir)
  };
  return { ...manifest, manifestHash: manifestHash(manifest) };
}

function assertValidManifest(manifest = {}) {
  if (manifest.kind !== 'memory_vector_legacy_archive' || manifest.version !== 1) {
    throw new Error('Invalid legacy archive manifest');
  }
  if (!manifest.manifestHash || manifestHash(manifest) !== manifest.manifestHash) {
    throw new Error('Legacy archive manifest hash mismatch');
  }
}

function sameSourceEntry(left = {}, right = {}) {
  return left.originalPath === right.originalPath
    && left.exists === right.exists
    && left.type === right.type
    && Number(left.size || 0) === Number(right.size || 0)
    && Number(left.mtimeMs || 0) === Number(right.mtimeMs || 0)
    && left.sha256 === right.sha256;
}

function archiveLegacyFiles(options = {}) {
  const manifest = options.manifest || buildLegacyArchiveManifest(options);
  assertValidManifest(manifest);
  const currentEntries = legacyPathEntries(manifest.dataDir, manifest.targetDir);
  if (currentEntries.some((entry, index) => !sameSourceEntry(entry, manifest.entries[index]))) {
    throw new Error('Legacy archive source files changed');
  }
  if (fs.existsSync(manifest.targetDir)) {
    throw new Error(`Legacy archive target already exists: ${manifest.targetDir}`);
  }
  for (const entry of manifest.entries) {
    if (entry.exists && fs.existsSync(entry.archivePath)) {
      throw new Error(`Legacy archive destination already exists: ${entry.archivePath}`);
    }
  }

  ensureDir(manifest.targetDir);
  const moved = [];
  try {
    for (const entry of manifest.entries) {
      if (!entry.exists) continue;
      fs.renameSync(entry.originalPath, entry.archivePath);
      moved.push(entry);
    }
    atomicWriteJson(manifest.manifestPath, manifest);
    return {
      ok: true,
      targetDir: manifest.targetDir,
      manifestPath: manifest.manifestPath,
      manifestHash: manifest.manifestHash,
      moved: moved.length,
      entries: manifest.entries
    };
  } catch (error) {
    for (const entry of moved.reverse()) {
      if (fs.existsSync(entry.archivePath) && !fs.existsSync(entry.originalPath)) {
        fs.renameSync(entry.archivePath, entry.originalPath);
      }
    }
    throw error;
  }
}

function restoreLegacyArchive(input) {
  const manifestPath = typeof input === 'string'
    ? input
    : input?.manifestPath || path.join(input?.targetDir || '', 'manifest.json');
  const manifest = safeReadJson(manifestPath, null);
  if (!manifest) return { ok: false, reason: 'legacy_archive_manifest_not_found', restored: [] };
  assertValidManifest(manifest);

  const expectedEntries = manifest.entries.filter((entry) => entry.exists);
  for (const entry of expectedEntries) {
    const archived = fs.existsSync(entry.archivePath);
    const restored = fs.existsSync(entry.originalPath);
    if (archived && restored) {
      throw new Error(`Legacy restore target already exists: ${entry.originalPath}`);
    }
    if (!archived && !restored) {
      throw new Error(`Legacy archive entry is missing: ${entry.originalPath}`);
    }
    const currentPath = archived ? entry.archivePath : entry.originalPath;
    if (sha256Path(currentPath) !== entry.sha256) {
      throw new Error(`Legacy archive content hash mismatch: ${currentPath}`);
    }
  }

  const pending = expectedEntries.filter((entry) => fs.existsSync(entry.archivePath));
  const restored = [];
  for (const entry of pending) {
    ensureDir(path.dirname(entry.originalPath));
    fs.renameSync(entry.archivePath, entry.originalPath);
    restored.push(entry.originalPath);
  }
  return {
    ok: true,
    manifestPath,
    restored,
    remaining: manifest.entries.filter((entry) => entry.exists && fs.existsSync(entry.archivePath)).length
  };
}

module.exports = {
  LEGACY_VECTOR_PATHS,
  archiveLegacyFiles,
  buildLegacyArchiveManifest,
  legacyPathEntries,
  manifestHash,
  restoreLegacyArchive,
  sha256Path,
  timestampForArchive
};

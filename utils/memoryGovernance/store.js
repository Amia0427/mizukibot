const fs = require('fs');
const path = require('path');

function createMemoryGovernanceStore(deps = {}) {
  const {
    itemsFile,
    snapshotDir
  } = deps;

  function safeReadJson(filePath, fallback) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (!raw || !raw.trim()) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      console.error('[memoryGovernance] read json failed:', filePath, e.message);
      return fallback;
    }
  }

  function atomicWriteJson(filePath, obj) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    const text = JSON.stringify(obj, null, 2);
    try {
      fs.writeFileSync(tmp, text, 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch (e) {
      try {
        fs.writeFileSync(filePath, text, 'utf-8');
      } finally {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch (_) {}
      }
      if (e.code !== 'EPERM' && e.code !== 'EXDEV') throw e;
    }
  }

  function ensureSnapshotDir() {
    if (!fs.existsSync(snapshotDir)) {
      fs.mkdirSync(snapshotDir, { recursive: true });
    }
  }

  function resolveSnapshotPath(snapshotFile) {
    const name = String(snapshotFile || '').trim();
    if (!name) throw new Error('snapshot file is required');
    if (path.basename(name) !== name) throw new Error('invalid snapshot file name');
    if (!/^memory_items_.*\.json$/i.test(name)) throw new Error('invalid snapshot file name');

    const root = path.resolve(snapshotDir);
    const fullPath = path.resolve(path.join(snapshotDir, name));
    const rel = path.relative(root, fullPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('snapshot file must stay inside snapshot dir');
    }
    return { name, fullPath };
  }

  function loadLibrary() {
    const fallback = { version: 2, items: [] };
    const data = safeReadJson(itemsFile, fallback);
    if (!data || typeof data !== 'object') return fallback;
    if (!Array.isArray(data.items)) data.items = [];
    return { version: 2, items: data.items };
  }

  function saveLibrary(library) {
    atomicWriteJson(itemsFile, {
      version: 2,
      items: Array.isArray(library?.items) ? library.items : []
    });
  }

  function createSnapshot(label = 'manual') {
    ensureSnapshotDir();
    const safeLabel = String(label || 'manual').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 24) || 'manual';
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const file = `memory_items_${stamp}_${safeLabel}.json`;
    const fullPath = path.join(snapshotDir, file);
    const library = loadLibrary();
    atomicWriteJson(fullPath, library);
    return file;
  }

  function listSnapshots(limit = 30) {
    ensureSnapshotDir();
    const files = fs.readdirSync(snapshotDir)
      .filter((name) => /^memory_items_.*\.json$/i.test(name))
      .map((name) => {
        const full = path.join(snapshotDir, name);
        const stat = fs.statSync(full);
        return {
          file: name,
          size: stat.size,
          createdAt: stat.mtimeMs
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    return files.slice(0, Math.max(1, Math.min(200, Number(limit) || 30)));
  }

  return {
    safeReadJson,
    atomicWriteJson,
    ensureSnapshotDir,
    resolveSnapshotPath,
    loadLibrary,
    saveLibrary,
    createSnapshot,
    listSnapshots
  };
}

module.exports = {
  createMemoryGovernanceStore
};

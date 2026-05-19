const fs = require('fs');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeReadJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[memory] failed to read json:', filePath, e.message);
    return fallback;
  }
}

function atomicWriteJson(targetFile, obj) {
  const tempFile = `${targetFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tempFile, targetFile);
  } catch (e) {
    // On Windows, rename can fail with EPERM when target is temporarily locked.
    // Fallback keeps data persistence available even when atomic rename is blocked.
    try {
      fs.writeFileSync(targetFile, JSON.stringify(obj, null, 2), 'utf-8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    if (e && e.code !== 'EPERM') throw e;
  }
}

function createMemoryFlushScheduler(deps = {}) {
  const {
    config,
    flushScheduledProjectionSave,
    getFavorites,
    getMemories,
    sanitizeAllLegacyMemories
  } = deps;
  let dataFlushTimer = null;
  let memoryFlushTimer = null;

  function scheduleDataFlush() {
    if (dataFlushTimer) return;
    dataFlushTimer = setTimeout(() => {
      dataFlushTimer = null;
      try {
        atomicWriteJson(config.DATA_FILE, getFavorites());
      } catch (e) {
        console.error('[memory] failed to flush favorites:', e.message);
      }
    }, 120);
  }

  function scheduleMemoryFlush() {
    if (memoryFlushTimer) return;
    memoryFlushTimer = setTimeout(() => {
      memoryFlushTimer = null;
      try {
        atomicWriteJson(config.MEMORY_FILE, getMemories());
      } catch (e) {
        if (String(e?.message || '').includes('Invalid string length')) {
          try {
            sanitizeAllLegacyMemories();
            atomicWriteJson(config.MEMORY_FILE, getMemories());
            console.warn('[memory] sanitized oversized legacy memories before retrying flush');
            return;
          } catch (retryErr) {
            console.error('[memory] failed to flush memories after sanitize:', retryErr.message);
            return;
          }
        }
        console.error('[memory] failed to flush memories:', e.message);
      }
    }, 120);
  }

  function flushAllSync() {
    try {
      if (dataFlushTimer) {
        clearTimeout(dataFlushTimer);
        dataFlushTimer = null;
      }
      if (memoryFlushTimer) {
        clearTimeout(memoryFlushTimer);
        memoryFlushTimer = null;
      }
      atomicWriteJson(config.DATA_FILE, getFavorites());
      atomicWriteJson(config.MEMORY_FILE, getMemories());
      flushScheduledProjectionSave();
    } catch (e) {
      console.error('[memory] failed to flush on exit:', e.message);
    }
  }

  return {
    flushAllSync,
    scheduleDataFlush,
    scheduleMemoryFlush
  };
}

module.exports = {
  atomicWriteJson,
  createMemoryFlushScheduler,
  ensureDir,
  safeReadJson
};

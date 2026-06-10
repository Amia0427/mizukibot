const fs = require('fs');
const path = require('path');
const { rotateFileIfNeeded } = require('./logRotation');

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_DELAY_MS = 3000;
const STORE_REGISTRY = new Set();
const JSON_HOT_STORE_HOOK_KEY = '__mizuki_json_hot_store_flush_hooks_registered__';
const DEFAULT_FLUSH_RETRY_MS = 5000;

function ensureDir(filePath) {
  const dir = path.dirname(String(filePath || ''));
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isRecoverableWriteError(error) {
  return error && ['EPERM', 'EACCES', 'EXDEV'].includes(error.code);
}

function isPermissionWriteError(error) {
  return error && ['EPERM', 'EACCES'].includes(error.code);
}

function clearReadOnlyBit(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.chmodSync(filePath, 0o666);
    return true;
  } catch (_) {
    return false;
  }
}

function atomicWriteFile(filePath, text, encoding = 'utf8') {
  ensureDir(filePath);
  const tempFile = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempFile, text, encoding);
    try {
      fs.renameSync(tempFile, filePath);
    } catch (renameError) {
      if (isPermissionWriteError(renameError) && clearReadOnlyBit(filePath)) {
        fs.renameSync(tempFile, filePath);
        return;
      }
      throw renameError;
    }
  } catch (error) {
    let fallbackError = null;
    if (isRecoverableWriteError(error)) {
      try {
        if (isPermissionWriteError(error)) clearReadOnlyBit(filePath);
        fs.writeFileSync(filePath, text, encoding);
        return;
      } catch (writeError) {
        fallbackError = writeError;
      }
    }
    try {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    } finally {
      if (fallbackError) throw fallbackError;
    }
    throw error;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (_) {
    return null;
  }
}

function defaultJsonDeserialize(raw = '', fallback) {
  if (!String(raw || '').trim()) return typeof fallback === 'function' ? fallback() : fallback;
  return JSON.parse(raw);
}

function hasNulBytes(raw = '') {
  return String(raw || '').includes('\u0000');
}

function defaultJsonSerialize(value) {
  return JSON.stringify(value, null, 2);
}

function registerFlushHooks() {
  if (process[JSON_HOT_STORE_HOOK_KEY]) return;
  process[JSON_HOT_STORE_HOOK_KEY] = true;
  const flushAll = () => flushAllHotStoresSync();
  process.once('beforeExit', flushAll);
  process.once('SIGINT', () => {
    flushAll();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    flushAll();
    process.exit(143);
  });
}

function createHotStore(filePath, options = {}) {
  registerFlushHooks();
  const store = {
    filePath,
    fallback: options.fallback,
    encoding: options.encoding || 'utf8',
    deserialize: typeof options.deserialize === 'function' ? options.deserialize : ((raw) => raw),
    serialize: typeof options.serialize === 'function' ? options.serialize : ((value) => String(value ?? '')),
    debounceMs: Math.max(0, Number(options.debounceMs) || DEFAULT_DEBOUNCE_MS),
    maxDelayMs: Math.max(0, Number(options.maxDelayMs) || DEFAULT_MAX_DELAY_MS),
    data: undefined,
    loaded: false,
    dirty: false,
    firstDirtyAt: 0,
    timer: null,
    lastLoadedAt: 0,
    lastLoadedMtimeMs: 0,
    flushCount: 0,
    readCount: 0,
    flushErrorCount: 0
  };

  function clearTimer() {
    if (store.timer) {
      clearTimeout(store.timer);
      store.timer = null;
    }
  }

  function fallbackValue() {
    return typeof store.fallback === 'function' ? store.fallback() : store.fallback;
  }

  function loadFromDisk(force = false) {
    const stat = safeStat(store.filePath);
    if (
      !force
      && store.loaded
      && !store.dirty
      && stat
      && Number(stat.mtimeMs || 0) <= Number(store.lastLoadedMtimeMs || 0)
    ) {
      return store.data;
    }
    if (!stat) {
      store.data = fallbackValue();
      store.loaded = true;
      store.lastLoadedAt = Date.now();
      store.lastLoadedMtimeMs = 0;
      store.readCount += 1;
      return store.data;
    }
    const raw = fs.readFileSync(store.filePath, store.encoding);
    const fallback = fallbackValue();
    try {
      if (hasNulBytes(raw)) {
        throw new Error('file contains NUL bytes');
      }
      store.data = store.deserialize(raw, fallback);
    } catch (error) {
      console.error('[jsonHotStore] failed to read store, using fallback:', {
        filePath: store.filePath,
        error: error?.message || String(error || '')
      });
      store.data = fallback;
    }
    store.loaded = true;
    store.lastLoadedAt = Date.now();
    store.lastLoadedMtimeMs = Number(stat.mtimeMs || 0) || Date.now();
    store.readCount += 1;
    return store.data;
  }

  function read(options = {}) {
    if (!store.loaded) return loadFromDisk(false);
    if (options.forceReload) return loadFromDisk(true);
    if (!store.dirty) {
      const stat = safeStat(store.filePath);
      if (stat && Number(stat.mtimeMs || 0) > Number(store.lastLoadedMtimeMs || 0)) {
        return loadFromDisk(true);
      }
    }
    return store.data;
  }

  function flushSync() {
    if (!store.loaded || !store.dirty) return false;
    const serialized = store.serialize(store.data);
    atomicWriteFile(store.filePath, serialized, store.encoding);
    const stat = safeStat(store.filePath);
    store.dirty = false;
    store.firstDirtyAt = 0;
    store.lastLoadedAt = Date.now();
    store.lastLoadedMtimeMs = Number(stat?.mtimeMs || Date.now()) || Date.now();
    store.flushCount += 1;
    store.flushErrorCount = 0;
    clearTimer();
    return true;
  }

  function scheduleFlush(options = {}) {
    clearTimer();
    const retryDelayMs = Number(options.retryDelayMs);
    const waitMs = Number.isFinite(retryDelayMs) && retryDelayMs > 0
      ? retryDelayMs
      : (() => {
          const elapsed = store.firstDirtyAt ? (Date.now() - store.firstDirtyAt) : 0;
          const remaining = Math.max(0, store.maxDelayMs - elapsed);
          return Math.min(store.debounceMs, remaining);
        })();
    store.timer = setTimeout(() => {
      try {
        flushSync();
      } catch (error) {
        store.flushErrorCount += 1;
        console.error('[jsonHotStore] scheduled flush failed, will retry:', {
          filePath: store.filePath,
          error: error?.message || String(error || ''),
          flushErrorCount: store.flushErrorCount
        });
        if (store.dirty) {
          scheduleFlush({ retryDelayMs: DEFAULT_FLUSH_RETRY_MS });
        }
      }
    }, waitMs);
  }

  function markDirty() {
    if (!store.loaded) read();
    if (!store.dirty) store.firstDirtyAt = Date.now();
    store.dirty = true;
    scheduleFlush();
    return store.data;
  }

  function replace(value, options = {}) {
    store.data = value;
    store.loaded = true;
    if (options.flushNow) {
      store.dirty = true;
      store.firstDirtyAt = Date.now();
      flushSync();
      return store.data;
    }
    markDirty();
    return store.data;
  }

  function update(mutator, options = {}) {
    const current = read();
    const nextValue = typeof mutator === 'function' ? mutator(current) : current;
    if (nextValue !== undefined) {
      store.data = nextValue;
      store.loaded = true;
    }
    if (options.flushNow) {
      store.dirty = true;
      store.firstDirtyAt = Date.now();
      flushSync();
      return store.data;
    }
    markDirty();
    return store.data;
  }

  function invalidate() {
    clearTimer();
    store.data = undefined;
    store.loaded = false;
    store.dirty = false;
    store.firstDirtyAt = 0;
    store.lastLoadedAt = 0;
    store.lastLoadedMtimeMs = 0;
  }

  function getMeta() {
    return {
      filePath: store.filePath,
      loaded: store.loaded,
      dirty: store.dirty,
      lastLoadedAt: store.lastLoadedAt,
      lastLoadedMtimeMs: store.lastLoadedMtimeMs,
      flushCount: store.flushCount,
      flushErrorCount: store.flushErrorCount,
      readCount: store.readCount
    };
  }

  const api = {
    read,
    replace,
    update,
    markDirty,
    flushSync,
    invalidate,
    getMeta
  };

  STORE_REGISTRY.add(api);
  return api;
}

function createJsonHotStore(filePath, options = {}) {
  return createHotStore(filePath, {
    ...options,
    deserialize: options.deserialize || defaultJsonDeserialize,
    serialize: options.serialize || defaultJsonSerialize
  });
}

function createTextHotStore(filePath, options = {}) {
  return createHotStore(filePath, {
    ...options,
    fallback: options.fallback ?? '',
    deserialize: options.deserialize || ((raw) => String(raw || '')),
    serialize: options.serialize || ((value) => String(value || ''))
  });
}

function createJsonLineHotWriter(filePath, options = {}) {
  registerFlushHooks();
  const writer = {
    filePath,
    encoding: options.encoding || 'utf8',
    debounceMs: Math.max(0, Number(options.debounceMs) || DEFAULT_DEBOUNCE_MS),
    maxDelayMs: Math.max(0, Number(options.maxDelayMs) || DEFAULT_MAX_DELAY_MS),
    rotateMaxBytes: options.rotateMaxBytes,
    rotateMaxFiles: options.rotateMaxFiles,
    serializeLine: typeof options.serializeLine === 'function'
      ? options.serializeLine
      : ((value) => JSON.stringify(value)),
    pendingLines: [],
    dirty: false,
    firstDirtyAt: 0,
    timer: null,
    flushCount: 0
  };

  function clearTimer() {
    if (writer.timer) {
      clearTimeout(writer.timer);
      writer.timer = null;
    }
  }

  function flushSync() {
    if (!writer.dirty || writer.pendingLines.length === 0) return false;
    ensureDir(writer.filePath);
    const lines = writer.pendingLines.splice(0, writer.pendingLines.length);
    writer.dirty = false;
    writer.firstDirtyAt = 0;
    clearTimer();
    try {
      const body = `${lines.join('\n')}\n`;
      rotateFileIfNeeded(writer.filePath, Buffer.byteLength(body, writer.encoding), {
        maxBytes: writer.rotateMaxBytes,
        maxFiles: writer.rotateMaxFiles
      });
      fs.appendFileSync(writer.filePath, body, writer.encoding);
      writer.flushCount += 1;
      return true;
    } catch (error) {
      writer.pendingLines.unshift(...lines);
      writer.dirty = writer.pendingLines.length > 0;
      if (writer.dirty && !writer.firstDirtyAt) writer.firstDirtyAt = Date.now();
      throw error;
    }
  }

  function scheduleFlush() {
    clearTimer();
    const elapsed = writer.firstDirtyAt ? (Date.now() - writer.firstDirtyAt) : 0;
    const remaining = Math.max(0, writer.maxDelayMs - elapsed);
    const waitMs = Math.min(writer.debounceMs, remaining);
    writer.timer = setTimeout(() => {
      try {
        flushSync();
      } catch (error) {
        console.error('[jsonHotStore] jsonl flush failed:', error?.message || error);
      }
    }, waitMs);
  }

  function append(value) {
    const line = writer.serializeLine(value);
    if (!line) return 0;
    writer.pendingLines.push(String(line));
    writer.dirty = true;
    if (!writer.firstDirtyAt) writer.firstDirtyAt = Date.now();
    scheduleFlush();
    return writer.pendingLines.length;
  }

  function getMeta() {
    return {
      filePath: writer.filePath,
      dirty: writer.dirty,
      pendingLines: writer.pendingLines.length,
      flushCount: writer.flushCount
    };
  }

  const api = {
    append,
    flushSync,
    getMeta
  };

  STORE_REGISTRY.add(api);
  return api;
}

function flushAllHotStoresSync() {
  let flushed = 0;
  for (const store of STORE_REGISTRY) {
    try {
      if (store.flushSync()) flushed += 1;
    } catch (error) {
      console.error('[jsonHotStore] flush failed:', error?.message || error);
    }
  }
  return flushed;
}

module.exports = {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_FLUSH_RETRY_MS,
  createJsonLineHotWriter,
  createJsonHotStore,
  createTextHotStore,
  flushAllHotStoresSync
};

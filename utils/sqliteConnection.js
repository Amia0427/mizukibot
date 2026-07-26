const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const CHECKPOINT_MODES = new Set(['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE']);
const LOCK_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function normalizeBusyTimeout(value) {
  const timeout = Number(value);
  return Number.isInteger(timeout) && timeout >= 0 ? timeout : DEFAULT_BUSY_TIMEOUT_MS;
}

function waitForLockRetry(delayMs = 25) {
  Atomics.wait(LOCK_RETRY_SIGNAL, 0, 0, delayMs);
}

function enableWal(db, busyTimeoutMs) {
  const deadline = Date.now() + busyTimeoutMs;
  while (true) {
    try {
      if (db.pragma('journal_mode', { simple: true }) === 'wal') return;
      const journalMode = db.pragma('journal_mode = WAL', { simple: true });
      if (journalMode === 'wal') return;
      if (Date.now() >= deadline) throw new Error(`failed to enable WAL journal mode: ${journalMode}`);
    } catch (error) {
      if (error.code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error;
    }
    waitForLockRetry();
  }
}

function openSqliteDatabase(Database, file, options = {}) {
  const busyTimeoutMs = normalizeBusyTimeout(options.busyTimeoutMs);
  const db = new Database(file, {
    readonly: options.readonly === true,
    fileMustExist: options.fileMustExist === true,
    timeout: busyTimeoutMs
  });
  try {
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    db.pragma('foreign_keys = ON');
    if (options.readonly !== true) enableWal(db, busyTimeoutMs);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function runQuickCheck(db) {
  const messages = db.pragma('quick_check').map((row) => row.quick_check);
  return {
    ok: messages.length === 1 && messages[0] === 'ok',
    messages
  };
}

function runWalCheckpoint(db, mode = 'PASSIVE') {
  const normalizedMode = String(mode || '').trim().toUpperCase();
  if (!CHECKPOINT_MODES.has(normalizedMode)) {
    throw new TypeError(`unsupported WAL checkpoint mode: ${mode}`);
  }
  const result = db.pragma(`wal_checkpoint(${normalizedMode})`)[0];
  return {
    busy: result.busy,
    logFrames: result.log,
    checkpointedFrames: result.checkpointed
  };
}

module.exports = {
  DEFAULT_BUSY_TIMEOUT_MS,
  openSqliteDatabase,
  runQuickCheck,
  runWalCheckpoint
};

const fs = require('fs');
const path = require('path');

const DEFAULT_STALE_MS = 10 * 60 * 1000;

function isProcessAlive(pid) {
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0) return false;
  try {
    process.kill(normalized, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function readLock(lockFile) {
  try {
    if (!fs.existsSync(lockFile)) return null;
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

function acquireMaterializeLock(lockFile, options = {}) {
  const staleMs = Math.max(1000, Number(options.staleMs || DEFAULT_STALE_MS) || DEFAULT_STALE_MS);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  const payload = {
    pid: process.pid,
    acquiredAt: Date.now()
  };

  const tryWrite = () => {
    fs.writeFileSync(lockFile, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' });
    return true;
  };

  try {
    tryWrite();
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;

    const existing = readLock(lockFile);
    const ageMs = Date.now() - Number(existing?.acquiredAt || 0);
    const stale = ageMs > staleMs || !isProcessAlive(Number(existing?.pid || 0));
    if (!stale) {
      return {
        acquired: false,
        reason: 'busy',
        existing
      };
    }

    try {
      fs.unlinkSync(lockFile);
    } catch (_) {}

    try {
      tryWrite();
    } catch (_) {
      return {
        acquired: false,
        reason: 'busy_after_stale_cleanup',
        existing
      };
    }
  }

  let released = false;
  return {
    acquired: true,
    release() {
      if (released) return;
      released = true;
      const current = readLock(lockFile);
      if (Number(current?.pid || 0) !== process.pid) return;
      try {
        fs.unlinkSync(lockFile);
      } catch (_) {}
    }
  };
}

module.exports = {
  DEFAULT_STALE_MS,
  acquireMaterializeLock,
  readMaterializeLock: readLock,
  isProcessAlive
};

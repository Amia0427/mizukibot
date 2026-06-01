const fs = require('fs');
const path = require('path');
const {
  compactProcess,
  findProcessByPid,
  isProcessAliveDefault,
  listProcessesDefault,
  normalizePid,
  processMatchesPostReplyWorker
} = require('../runtimeStatusDiagnostics/processes');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function safeMkdirForFile(filePath = '') {
  const dir = path.dirname(filePath);
  if (!dir || dir === '.') return;
  fs.mkdirSync(dir, { recursive: true });
}

function readOwnerPid(filePath = '') {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const raw = normalizeText(fs.readFileSync(filePath, 'utf8'));
    if (!raw) return 0;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw);
      return normalizePid(parsed?.pid || parsed?.ownerPid);
    }
    return normalizePid(raw.split(/\r?\n/)[0]);
  } catch (_) {
    return 0;
  }
}

function writePidFile(filePath = '', pid = 0) {
  safeMkdirForFile(filePath);
  fs.writeFileSync(filePath, `${normalizePid(pid)}\n`, 'utf8');
}

function writeLockFile(filePath = '', pid = 0) {
  safeMkdirForFile(filePath);
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify({
      pid: normalizePid(pid),
      acquiredAt: new Date().toISOString()
    }) + '\n', 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function removeOwnedPidFile(filePath = '', pid = 0) {
  try {
    if (readOwnerPid(filePath) === normalizePid(pid)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch (_) {}
  return false;
}

function removeOwnedLockFile(filePath = '', pid = 0) {
  return removeOwnedPidFile(filePath, pid);
}

function safeListProcesses(listProcesses) {
  try {
    return listProcesses().map((row) => ({
      pid: normalizePid(row.pid ?? row.ProcessId),
      ppid: normalizePid(row.ppid ?? row.ParentProcessId),
      name: normalizeText(row.name ?? row.Name),
      commandLine: normalizeText(row.commandLine ?? row.CommandLine),
      startTimeMs: Math.max(0, Number(row.startTimeMs ?? row.StartTimeMs ?? row.startTime ?? row.StartTime ?? 0) || 0)
    })).filter((row) => row.pid);
  } catch (_) {
    return [];
  }
}

function processLooksLikeWorker(proc = null) {
  if (!proc) return false;
  if (processMatchesPostReplyWorker(proc)) return true;
  return !normalizeText(proc.commandLine) && /node/i.test(normalizeText(proc.name));
}

function findExistingWorkerProcess({
  processes = [],
  currentPid = process.pid,
  isProcessAlive = isProcessAliveDefault
} = {}) {
  const current = normalizePid(currentPid);
  return processes
    .filter((proc) => {
      const pid = normalizePid(proc.pid);
      return pid && pid !== current && isProcessAlive(pid) && processMatchesPostReplyWorker(proc);
    })
    .sort((a, b) => normalizePid(a.pid) - normalizePid(b.pid))[0] || null;
}

function getAliveRecordedWorker({
  filePath = '',
  processes = [],
  currentPid = process.pid,
  isProcessAlive = isProcessAliveDefault
} = {}) {
  const ownerPid = readOwnerPid(filePath);
  if (!ownerPid || ownerPid === normalizePid(currentPid) || !isProcessAlive(ownerPid)) {
    return null;
  }
  const proc = findProcessByPid(processes, ownerPid);
  if (processLooksLikeWorker(proc) || !proc) {
    return {
      pid: ownerPid,
      process: proc ? compactProcess(proc) : null
    };
  }
  return null;
}

function cleanupStaleOwnerFile({
  filePath = '',
  processes = [],
  currentPid = process.pid,
  isProcessAlive = isProcessAliveDefault
} = {}) {
  const ownerPid = readOwnerPid(filePath);
  if (!ownerPid || ownerPid === normalizePid(currentPid)) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
    return true;
  }
  if (!isProcessAlive(ownerPid)) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    return true;
  }
  const proc = findProcessByPid(processes, ownerPid);
  if (proc && !processLooksLikeWorker(proc)) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    return true;
  }
  return false;
}

function acquirePostReplyWorkerSingleInstance(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..', '..'));
  const pidFile = path.resolve(options.pidFile || path.join(projectRoot, '.mizukibot-postreply-worker.pid'));
  const lockFile = path.resolve(options.lockFile || path.join(projectRoot, '.mizukibot-postreply-worker.lock'));
  const currentPid = normalizePid(options.currentPid || process.pid);
  const listProcesses = typeof options.listProcesses === 'function'
    ? options.listProcesses
    : listProcessesDefault;
  const isProcessAlive = typeof options.isProcessAlive === 'function'
    ? options.isProcessAlive
    : isProcessAliveDefault;
  const currentStartedAt = Math.max(0, Number(options.currentStartedAt || Date.now()) || 0);
  const startupGraceMs = Math.max(0, Number(options.startupGraceMs ?? 10000) || 0);

  let processes = safeListProcesses(listProcesses);
  const recordedLockWorker = getAliveRecordedWorker({
    filePath: lockFile,
    processes,
    currentPid,
    isProcessAlive
  });
  if (recordedLockWorker) {
    writePidFile(pidFile, recordedLockWorker.pid);
    return {
      acquired: false,
      reason: 'lock_owner_running',
      ownerPid: recordedLockWorker.pid,
      process: recordedLockWorker.process,
      cleanup: () => false
    };
  }

  const recordedPidWorker = getAliveRecordedWorker({
    filePath: pidFile,
    processes,
    currentPid,
    isProcessAlive
  });
  if (recordedPidWorker) {
    return {
      acquired: false,
      reason: 'pid_file_owner_running',
      ownerPid: recordedPidWorker.pid,
      process: recordedPidWorker.process,
      cleanup: () => false
    };
  }

  cleanupStaleOwnerFile({ filePath: lockFile, processes, currentPid, isProcessAlive });
  cleanupStaleOwnerFile({ filePath: pidFile, processes, currentPid, isProcessAlive });

  const existingProcess = findExistingWorkerProcess({ processes, currentPid, isProcessAlive });
  const existingStartMs = Math.max(0, Number(existingProcess?.startTimeMs || 0) || 0);
  const existingIsConcurrentPeer = existingProcess
    && existingStartMs > 0
    && currentStartedAt > 0
    && Math.abs(currentStartedAt - existingStartMs) <= startupGraceMs;
  if (existingProcess && !existingIsConcurrentPeer) {
    writePidFile(pidFile, existingProcess.pid);
    return {
      acquired: false,
      reason: 'existing_worker_process',
      ownerPid: normalizePid(existingProcess.pid),
      process: compactProcess(existingProcess),
      cleanup: () => false
    };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    processes = safeListProcesses(listProcesses);
    const recordedLockWorker = getAliveRecordedWorker({
      filePath: lockFile,
      processes,
      currentPid,
      isProcessAlive
    });
    if (recordedLockWorker) {
      writePidFile(pidFile, recordedLockWorker.pid);
      return {
        acquired: false,
        reason: 'lock_owner_running',
        ownerPid: recordedLockWorker.pid,
        process: recordedLockWorker.process,
        cleanup: () => false
      };
    }

    cleanupStaleOwnerFile({ filePath: lockFile, processes, currentPid, isProcessAlive });

    try {
      writeLockFile(lockFile, currentPid);
      writePidFile(pidFile, currentPid);
      let released = false;
      const cleanup = () => {
        if (released) return false;
        released = true;
        const removedPid = removeOwnedPidFile(pidFile, currentPid);
        const removedLock = removeOwnedLockFile(lockFile, currentPid);
        return removedPid || removedLock;
      };
      return {
        acquired: true,
        reason: 'acquired',
        ownerPid: currentPid,
        pidFile,
        lockFile,
        cleanup
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
  }

  const ownerPid = readOwnerPid(lockFile) || readOwnerPid(pidFile);
  return {
    acquired: false,
    reason: 'lock_busy',
    ownerPid,
    process: compactProcess(findProcessByPid(safeListProcesses(listProcesses), ownerPid)),
    cleanup: () => false
  };
}

module.exports = {
  acquirePostReplyWorkerSingleInstance,
  findExistingWorkerProcess,
  processLooksLikeWorker,
  readOwnerPid
};

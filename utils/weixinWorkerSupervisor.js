const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  isProcessAliveDefault,
  listProcessesDefault
} = require('./runtimeStatusDiagnostics/processes');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PID_FILE = path.join(PROJECT_ROOT, '.mizukibot-weixin-worker.pid');
const DEFAULT_LOCK_FILE = path.join(PROJECT_ROOT, '.mizukibot-weixin-worker.lock');

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function readOwnerPid(filePath) {
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim();
    if (value.startsWith('{')) return normalizePid(JSON.parse(value).pid);
    return normalizePid(value.split(/\r?\n/)[0]);
  } catch (_) {
    return 0;
  }
}

function processMatchesWeixinWorker(proc, projectRoot) {
  const name = path.basename(String(proc.name || proc.Name || '')).toLowerCase();
  const commandLine = String(proc.commandLine || proc.CommandLine || '').replace(/\\/g, '/').toLowerCase();
  const root = path.resolve(projectRoot).replace(/\\/g, '/').toLowerCase();
  return (name === 'node' || name === 'node.exe')
    && /(^|[\s/"'])weixin-worker\.js(["']?)(\s|$)/i.test(commandLine)
    && commandLine.includes(root);
}

function safeProcesses(listProcesses) {
  try {
    return listProcesses();
  } catch (_) {
    return [];
  }
}

function hasRunningWeixinWorker(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const pidFile = path.resolve(options.pidFile || DEFAULT_PID_FILE);
  const listProcesses = options.listProcesses || listProcessesDefault;
  const isProcessAlive = options.isProcessAlive || isProcessAliveDefault;
  const processes = safeProcesses(listProcesses);
  const ownerPid = readOwnerPid(pidFile);
  if (ownerPid && isProcessAlive(ownerPid)) {
    const owner = processes.find((proc) => normalizePid(proc.pid ?? proc.ProcessId) === ownerPid);
    if (!owner || processMatchesWeixinWorker(owner, projectRoot)) return true;
  }
  return processes.some((proc) => {
    const pid = normalizePid(proc.pid ?? proc.ProcessId);
    return pid && isProcessAlive(pid) && processMatchesWeixinWorker(proc, projectRoot);
  });
}

function removeOwnedFile(filePath, pid) {
  if (readOwnerPid(filePath) !== pid) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireWeixinWorkerSingleInstance(options = {}) {
  const pidFile = path.resolve(options.pidFile || DEFAULT_PID_FILE);
  const lockFile = path.resolve(options.lockFile || DEFAULT_LOCK_FILE);
  const currentPid = normalizePid(options.currentPid || process.pid);
  const isProcessAlive = options.isProcessAlive || isProcessAliveDefault;
  const ownerPid = readOwnerPid(lockFile) || readOwnerPid(pidFile);
  if (ownerPid && ownerPid !== currentPid && isProcessAlive(ownerPid)) {
    return { acquired: false, ownerPid, reason: 'already_running', cleanup: () => false };
  }
  for (const filePath of [lockFile, pidFile]) {
    if (readOwnerPid(filePath) && !isProcessAlive(readOwnerPid(filePath))) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: currentPid, acquiredAt: new Date().toISOString() })}\n`, 'utf8');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return {
      acquired: false,
      ownerPid: readOwnerPid(lockFile) || readOwnerPid(pidFile),
      reason: 'lock_busy',
      cleanup: () => false
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fs.writeFileSync(pidFile, `${currentPid}\n`, 'utf8');
  let released = false;
  return {
    acquired: true,
    ownerPid: currentPid,
    reason: 'acquired',
    cleanup() {
      if (released) return false;
      released = true;
      const removedPid = removeOwnedFile(pidFile, currentPid);
      const removedLock = removeOwnedFile(lockFile, currentPid);
      return removedPid || removedLock;
    }
  };
}

function ensureWeixinWorkerRunning(options = {}) {
  const enabled = options.enabled ?? String(process.env.WEIXIN_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) return { started: false, skipped: true, reason: 'disabled' };
  const supervisorEnabled = options.supervisorEnabled
    ?? String(process.env.WEIXIN_WORKER_SUPERVISOR_ENABLED || 'true').toLowerCase() !== 'false';
  if (!supervisorEnabled) return { started: false, skipped: true, reason: 'supervisor_disabled' };

  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const pidFile = path.resolve(options.pidFile || path.join(projectRoot, '.mizukibot-weixin-worker.pid'));
  if (hasRunningWeixinWorker({
    projectRoot,
    pidFile,
    listProcesses: options.listProcesses,
    isProcessAlive: options.isProcessAlive
  })) {
    return { started: false, skipped: true, reason: 'already_running' };
  }

  const spawnImpl = options.spawn || spawn;
  const scriptPath = path.join(projectRoot, 'scripts', 'weixin-worker.js');
  const child = spawnImpl(options.nodeExe || process.execPath, [scriptPath], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      MIZUKIBOT_PROJECT_ROOT: projectRoot,
      MIZUKIBOT_RUNTIME_ROLE: 'weixin_worker'
    }
  });
  child?.unref?.();
  return {
    started: true,
    skipped: false,
    reason: 'started',
    pid: normalizePid(child?.pid),
    scriptPath
  };
}

function getWeixinWorkerHealth(options = {}) {
  const stateFile = path.resolve(options.stateFile);
  const maxAgeMs = Math.max(1_000, Number(options.maxAgeMs || 60_000) || 60_000);
  const timestamp = Number(typeof options.now === 'function' ? options.now() : Date.now());
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_) {
    return { status: 'starting', stage: 'missing', heartbeatAgeMs: null };
  }
  const heartbeatAt = Date.parse(state.heartbeatAt);
  const heartbeatAgeMs = Number.isFinite(heartbeatAt) ? Math.max(0, timestamp - heartbeatAt) : null;
  const stage = String(state.stage || '').trim().toLowerCase();
  const activeStage = stage === 'ready' || stage === 'heartbeat';
  return {
    status: activeStage && heartbeatAgeMs !== null && heartbeatAgeMs <= maxAgeMs ? 'online' : 'degraded',
    stage: stage || 'unknown',
    heartbeatAgeMs,
    pid: normalizePid(state.pid)
  };
}

module.exports = {
  acquireWeixinWorkerSingleInstance,
  ensureWeixinWorkerRunning,
  getWeixinWorkerHealth,
  hasRunningWeixinWorker,
  processMatchesWeixinWorker,
  readOwnerPid
};

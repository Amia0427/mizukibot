const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const {
  findExistingWorkerProcess,
  readOwnerPid
} = require('./postReplyWorker/singleInstance');
const {
  isProcessAliveDefault,
  listProcessesDefault,
  processMatchesPostReplyWorker
} = require('./runtimeStatusDiagnostics/processes');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PID_FILE = path.join(PROJECT_ROOT, '.mizukibot-postreply-worker.pid');
let lastStartAttemptAt = 0;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizePid(value = 0) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function safeListProcesses(listProcesses = listProcessesDefault) {
  try {
    return listProcesses();
  } catch (_) {
    return [];
  }
}

function hasRunningPostReplyWorker({
  projectRoot = '',
  pidFile = DEFAULT_PID_FILE,
  listProcesses = listProcessesDefault,
  isProcessAlive = isProcessAliveDefault
} = {}) {
  const root = path.resolve(projectRoot || process.env.MIZUKIBOT_PROJECT_ROOT || path.dirname(pidFile) || PROJECT_ROOT);
  const processes = safeListProcesses(listProcesses);
  const pid = normalizePid(readOwnerPid(pidFile));
  if (pid && isProcessAlive(pid)) {
    const owner = processes.find((proc) => normalizePid(proc.pid ?? proc.ProcessId) === pid);
    if (!owner || processMatchesPostReplyWorker(owner, root)) return true;
  }
  return Boolean(findExistingWorkerProcess({
    processes,
    currentPid: process.pid,
    isProcessAlive,
    projectRoot: root
  }));
}

function ensurePostReplyWorkerRunning(options = {}) {
  if (config.POST_REPLY_WORKER_ENABLED !== true) {
    return { started: false, skipped: true, reason: 'disabled' };
  }
  if (config.POST_REPLY_WORKER_INLINE === true) {
    return { started: false, skipped: true, reason: 'inline' };
  }

  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const pidFile = path.resolve(options.pidFile || path.join(projectRoot, '.mizukibot-postreply-worker.pid'));
  const listProcesses = typeof options.listProcesses === 'function'
    ? options.listProcesses
    : listProcessesDefault;
  const isProcessAlive = typeof options.isProcessAlive === 'function'
    ? options.isProcessAlive
    : isProcessAliveDefault;

  if (hasRunningPostReplyWorker({ projectRoot, pidFile, listProcesses, isProcessAlive })) {
    return { started: false, skipped: true, reason: 'already_running' };
  }

  const now = typeof options.now === 'function' ? Number(options.now()) || Date.now() : Date.now();
  const configuredCooldownMs = Number(options.cooldownMs ?? config.POST_REPLY_WORKER_SUPERVISOR_COOLDOWN_MS);
  const cooldownMs = Math.max(0, Number.isFinite(configuredCooldownMs) ? configuredCooldownMs : 30000);
  if (cooldownMs > 0 && now - lastStartAttemptAt < cooldownMs) {
    return { started: false, skipped: true, reason: 'cooldown' };
  }

  lastStartAttemptAt = now;
  const spawnImpl = typeof options.spawn === 'function' ? options.spawn : spawn;
  const nodeExe = normalizeText(options.nodeExe || process.execPath) || 'node';
  const scriptPath = path.join(projectRoot, 'scripts', 'post-reply-worker.js');
  const child = spawnImpl(nodeExe, [scriptPath], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      MIZUKIBOT_PROJECT_ROOT: projectRoot,
      MIZUKIBOT_RUNTIME_ROLE: 'post_reply_worker'
    }
  });
  if (child && typeof child.unref === 'function') child.unref();
  return {
    started: true,
    skipped: false,
    reason: 'started',
    pid: normalizePid(child && child.pid),
    scriptPath
  };
}

module.exports = {
  ensurePostReplyWorkerRunning,
  hasRunningPostReplyWorker
};

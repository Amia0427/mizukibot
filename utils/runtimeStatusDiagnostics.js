const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../config');

const SCHEMA_VERSION = 'runtime_status_diagnostic_v1';
const ACTIVE_BACKGROUND_STATUSES = new Set(['queued', 'running', 'reviewing']);
const POST_REPLY_STATUSES = ['queued', 'processing', 'failed', 'done'];
const DEFAULT_BACKGROUND_TASK_STALE_MS = 30 * 60 * 1000;
const DEFAULT_LANGGRAPH_V2_CHECKPOINT_STALE_MS = 30 * 60 * 1000;
const LANGGRAPH_V2_ACTIVE_CHECKPOINT_STATUSES = new Set(['running', 'queued', 'reviewing']);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePid(value) {
  const pid = Math.floor(normalizeNumber(value, 0));
  return pid > 0 ? pid : 0;
}

function normalizePath(value = '') {
  const text = normalizeText(value);
  return text ? path.resolve(text) : '';
}

function nowMs(options = {}) {
  if (typeof options.now === 'function') {
    const value = options.now();
    if (value instanceof Date) return value.getTime();
    return normalizeNumber(value, Date.now());
  }
  return Date.now();
}

function isoFromMs(value) {
  const n = normalizeNumber(value, Date.now());
  return new Date(n).toISOString();
}

function safeStat(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      mtimeMs: normalizeNumber(stat.mtimeMs, 0),
      size: normalizeNumber(stat.size, 0)
    };
  } catch (_) {
    return {
      exists: false,
      mtimeMs: 0,
      size: 0
    };
  }
}

function safeReadText(filePath = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function safeReadJson(filePath = '', fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!normalizeText(raw)) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function safeReadDir(dirPath = '') {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function isProcessAliveDefault(pid = 0) {
  const targetPid = normalizePid(pid);
  if (!targetPid) return false;
  try {
    process.kill(targetPid, 0);
    return true;
  } catch (error) {
    return normalizeText(error?.code).toUpperCase() === 'EPERM';
  }
}

function parseWindowsProcessList(raw = '') {
  const text = normalizeText(raw);
  if (!text) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: normalizePid(row.ProcessId),
    ppid: normalizePid(row.ParentProcessId),
    name: normalizeText(row.Name),
    commandLine: normalizeText(row.CommandLine)
  })).filter((row) => row.pid);
}

function parseWindowsGetProcessList(raw = '') {
  const text = normalizeText(raw);
  if (!text) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: normalizePid(row.Id),
    ppid: 0,
    name: normalizeText(row.ProcessName || row.Name),
    commandLine: normalizeText(row.Path)
  })).filter((row) => row.pid);
}

function parsePosixProcessList(raw = '') {
  return String(raw || '').split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) return null;
    return {
      pid: normalizePid(match[1]),
      ppid: normalizePid(match[2]),
      name: normalizeText(match[3]),
      commandLine: normalizeText(match[4])
    };
  }).filter(Boolean);
}

function listProcessesDefault() {
  try {
    if (process.platform === 'win32') {
      const command = "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe' OR Name = 'cmd.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
      const raw = execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command
      ], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      });
      const cimRows = parseWindowsProcessList(raw);
      if (cimRows.length > 0) return cimRows;

      const fallbackRaw = execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "Get-Process node,powershell,pwsh,cmd -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress"
      ], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
      });
      return parseWindowsGetProcessList(fallbackRaw);
    }

    const raw = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], {
      encoding: 'utf8',
      timeout: 5000
    });
    return parsePosixProcessList(raw);
  } catch (_) {
    return [];
  }
}

function listProcesses(options = {}) {
  if (typeof options.listProcesses === 'function') {
    return options.listProcesses().map((row) => ({
      pid: normalizePid(row.pid ?? row.ProcessId),
      ppid: normalizePid(row.ppid ?? row.ParentProcessId),
      name: normalizeText(row.name ?? row.Name),
      commandLine: normalizeText(row.commandLine ?? row.CommandLine)
    })).filter((row) => row.pid);
  }
  return listProcessesDefault();
}

function findProcessByPid(processes = [], pid = 0) {
  const targetPid = normalizePid(pid);
  if (!targetPid) return null;
  return processes.find((proc) => normalizePid(proc.pid) === targetPid) || null;
}

function processMatchesMain(proc = {}) {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/');
  if (shouldExcludeOpenclawGatewayProcess(proc)) return false;
  return /(^|[\s/])index\.js(\s|$)/i.test(cmd) && processMatchesProjectRoot(proc);
}

function processMatchesPostReplyWorker(proc = {}) {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/');
  return /(^|[\s/])post-reply-worker\.js(\s|$)/i.test(cmd) && processMatchesProjectRoot(proc);
}

function processMatchesSubagent(proc = {}) {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/').toLowerCase();
  if (!cmd) return false;
  if (shouldExcludeOpenclawGatewayProcess(proc)) return false;
  if (!processMatchesProjectRoot(proc)) return false;
  return cmd.includes('subagent-command-worker.js')
    || cmd.includes('run-claude.ps1')
    || cmd.includes('subagent');
}

function getDiagnosticProjectRoot() {
  return path.resolve(__dirname, '..').replace(/\\/g, '/').toLowerCase();
}

function extractKnownProjectScriptTokens(cmd = '') {
  const tokens = [];
  const pattern = /"([^"]*(?:index|post-reply-worker|subagent-command-worker)\.js)"|'([^']*(?:index|post-reply-worker|subagent-command-worker)\.js)'|([^\s"]*(?:index|post-reply-worker|subagent-command-worker)\.js)/ig;
  let match = pattern.exec(cmd);
  while (match) {
    tokens.push(normalizeText(match[1] || match[2] || match[3]).replace(/\\/g, '/').toLowerCase());
    match = pattern.exec(cmd);
  }
  return tokens.filter(Boolean);
}

function isAbsoluteLikePath(value = '') {
  return /^[a-z]:\//i.test(value) || value.startsWith('/');
}

function processMatchesProjectRoot(proc = {}) {
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/').toLowerCase();
  if (!cmd) return false;
  const root = getDiagnosticProjectRoot();
  const rootWithSlash = root.endsWith('/') ? root : `${root}/`;
  if (cmd.includes(rootWithSlash)) return true;

  const scriptTokens = extractKnownProjectScriptTokens(cmd);
  if (scriptTokens.length > 0) {
    return scriptTokens.some((token) => !isAbsoluteLikePath(token) || token.includes(rootWithSlash));
  }
  return true;
}

function shouldExcludeOpenclawGatewayProcess(proc = {}) {
  if (config.DIAGNOSTICS_EXCLUDE_OPENCLAW_GATEWAY === false) return false;
  const cmd = normalizeText(proc.commandLine).replace(/\\/g, '/').toLowerCase();
  return cmd.includes('/openclaw/') && /\bgateway\b/.test(cmd);
}

function compactProcess(proc = null) {
  if (!proc) return null;
  return {
    pid: normalizePid(proc.pid),
    ppid: normalizePid(proc.ppid),
    name: normalizeText(proc.name),
    commandLine: normalizeText(proc.commandLine).slice(0, 500)
  };
}

function buildPidFileStatus({
  name,
  filePath,
  processes,
  isProcessAlive,
  expectedProcess = null,
  now
}) {
  const target = normalizePath(filePath);
  const stat = safeStat(target);
  const raw = stat.exists ? safeReadText(target).split(/\r?\n/)[0] || '' : '';
  const pid = normalizePid(raw);
  const alive = pid ? isProcessAlive(pid) : false;
  const proc = findProcessByPid(processes, pid);
  const hasCommandLine = Boolean(normalizeText(proc?.commandLine));
  const commandLineMatches = typeof expectedProcess === 'function'
    ? Boolean(proc && expectedProcess(proc))
    : true;
  let status = 'missing';
  if (stat.exists && !pid) status = 'invalid';
  if (stat.exists && pid && !alive) status = 'stale';
  if (stat.exists && pid && alive) {
    status = commandLineMatches || !hasCommandLine ? 'running' : 'mismatch';
  }
  return {
    name,
    path: target,
    exists: stat.exists,
    status,
    pid,
    raw: normalizeText(raw),
    processAlive: alive,
    commandLineMatches,
    mtimeMs: stat.mtimeMs,
    ageMs: stat.mtimeMs > 0 ? Math.max(0, now - stat.mtimeMs) : 0,
    size: stat.size,
    process: compactProcess(proc)
  };
}

function buildMemoryMaterializeLock({ filePath, isProcessAlive, now }) {
  const target = normalizePath(filePath);
  const stat = safeStat(target);
  const parsed = safeReadJson(target, null);
  const pid = normalizePid(parsed?.pid);
  const acquiredAt = normalizeNumber(parsed?.acquiredAt, 0);
  const ageMs = acquiredAt > 0 ? Math.max(0, now - acquiredAt) : 0;
  const staleMs = Math.max(1000, normalizeNumber(config.MEMORY_V3_MATERIALIZE_LOCK_STALE_MS, 10 * 60 * 1000));
  const alive = pid ? isProcessAlive(pid) : false;
  let status = 'missing';
  if (stat.exists && (!parsed || typeof parsed !== 'object')) status = 'invalid';
  if (stat.exists && parsed && typeof parsed === 'object') {
    status = ageMs > staleMs || !alive ? 'stale' : 'held';
  }
  return {
    name: 'memoryMaterializeLock',
    path: target,
    exists: stat.exists,
    status,
    pid,
    processAlive: alive,
    acquiredAt,
    ageMs,
    staleMs,
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

function buildCreateAgentRuntimeState({ filePath, isProcessAlive, now }) {
  const target = normalizePath(filePath);
  const stat = safeStat(target);
  const parsed = safeReadJson(target, {});
  const running = Math.max(0, normalizeNumber(parsed?.running, 0));
  const updatedAt = normalizeNumber(parsed?.updatedAt, 0);
  const ownerPid = normalizePid(parsed?.ownerPid);
  const alive = ownerPid ? isProcessAlive(ownerPid) : false;
  const ageMs = updatedAt > 0 ? Math.max(0, now - updatedAt) : 0;
  let status = 'missing';
  if (stat.exists) status = running > 0 ? 'active' : 'idle';
  if (stat.exists && running > 0 && ownerPid > 0 && !alive) status = 'stale';
  return {
    name: 'createAgentRuntime',
    path: target,
    exists: stat.exists,
    status,
    running,
    ownerPid,
    ownerAlive: alive,
    updatedAt,
    ageMs,
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

function readJsonFilesFromDir(dirPath = '') {
  return safeReadDir(dirPath)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const filePath = path.join(dirPath, entry.name);
      const parsed = safeReadJson(filePath, null);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { filePath, data: parsed }
        : null;
    })
    .filter(Boolean);
}

function readJsonStoreFiles(dirPath = '') {
  const target = normalizePath(dirPath);
  return safeReadDir(target)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const filePath = path.join(target, entry.name);
      const stat = safeStat(filePath);
      const data = safeReadJson(filePath, null);
      return {
        filePath,
        file: entry.name,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        valid: Boolean(data && typeof data === 'object'),
        data
      };
    });
}

function countByValue(items = [], getValue = () => '') {
  const counts = {};
  for (const item of items) {
    const key = normalizeText(getValue(item) || 'unknown') || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function sumStoreBytes(files = []) {
  return files.reduce((total, file) => total + Math.max(0, normalizeNumber(file.size, 0)), 0);
}

function buildLangGraphV2StoreSummary({
  checkpointDir,
  eventDir,
  now,
  staleCheckpointMs
}) {
  const normalizedCheckpointDir = normalizePath(checkpointDir);
  const normalizedEventDir = normalizePath(eventDir);
  const checkpointFiles = readJsonStoreFiles(normalizedCheckpointDir);
  const eventFiles = readJsonStoreFiles(normalizedEventDir);
  const checkpoints = checkpointFiles.map((file) => {
    const data = file.valid && !Array.isArray(file.data) ? file.data : {};
    const updatedAtMs = normalizeNumber(data.updatedAt, file.mtimeMs);
    const status = normalizeText(data.status || 'unknown') || 'unknown';
    const ageMs = updatedAtMs > 0 ? Math.max(0, now - updatedAtMs) : 0;
    const active = LANGGRAPH_V2_ACTIVE_CHECKPOINT_STATUSES.has(status);
    return {
      threadId: normalizeText(data.threadId || path.basename(file.file, '.json')),
      file: file.file,
      status,
      node: normalizeText(data.node),
      updatedAt: updatedAtMs > 0 ? isoFromMs(updatedAtMs) : '',
      ageMs,
      size: file.size,
      valid: file.valid && !Array.isArray(file.data),
      active,
      stale: active && ageMs > staleCheckpointMs
    };
  });
  const eventSummaries = eventFiles.map((file) => {
    const events = Array.isArray(file.data) ? file.data : [];
    const latestTs = events.reduce((maxTs, event) => {
      const ts = normalizeNumber(event?.ts, 0);
      return ts > maxTs ? ts : maxTs;
    }, 0);
    const updatedAtMs = latestTs || file.mtimeMs;
    return {
      threadId: path.basename(file.file, '.json'),
      file: file.file,
      eventCount: events.length,
      valid: Array.isArray(file.data),
      latestEventAt: updatedAtMs > 0 ? isoFromMs(updatedAtMs) : '',
      ageMs: updatedAtMs > 0 ? Math.max(0, now - updatedAtMs) : 0,
      size: file.size,
      countsByType: countByValue(events, (event) => event?.type)
    };
  });
  const staleRunningCheckpoints = checkpoints
    .filter((item) => item.stale)
    .sort((a, b) => b.ageMs - a.ageMs)
    .slice(0, 20);
  return {
    checkpointDir: normalizedCheckpointDir,
    eventDir: normalizedEventDir,
    checkpointDirExists: safeStat(normalizedCheckpointDir).exists,
    eventDirExists: safeStat(normalizedEventDir).exists,
    checkpointCount: checkpoints.length,
    eventFileCount: eventSummaries.length,
    totalCheckpointBytes: sumStoreBytes(checkpointFiles),
    totalEventBytes: sumStoreBytes(eventFiles),
    countsByCheckpointStatus: countByValue(checkpoints, (item) => item.status),
    activeCheckpointCount: checkpoints.filter((item) => item.active).length,
    staleRunningCheckpointCount: staleRunningCheckpoints.length,
    staleCheckpointMs,
    staleRunningCheckpoints,
    latestCheckpoints: checkpoints
      .slice()
      .sort((a, b) => a.ageMs - b.ageMs)
      .slice(0, 10),
    latestEventFiles: eventSummaries
      .slice()
      .sort((a, b) => a.ageMs - b.ageMs)
      .slice(0, 10),
    invalidCheckpointCount: checkpointFiles.filter((file) => !(file.valid && !Array.isArray(file.data))).length,
    invalidEventFileCount: eventFiles.filter((file) => !Array.isArray(file.data)).length
  };
}

function buildBackgroundTaskSummary({ storeDir, now, staleMs }) {
  const target = normalizePath(storeDir);
  const tasks = readJsonFilesFromDir(target).map(({ filePath, data }) => {
    const status = normalizeText(data.status || 'unknown') || 'unknown';
    const updatedAtText = normalizeText(data.updated_at || data.updatedAt || data.started_at || data.created_at);
    const updatedAtMs = Date.parse(updatedAtText);
    const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : 0;
    const active = ACTIVE_BACKGROUND_STATUSES.has(status);
    return {
      id: normalizeText(data.id),
      file: path.basename(filePath),
      status,
      stage: normalizeText(data.stage),
      executorType: normalizeText(data.executor_type || data.executorType),
      sessionKey: normalizeText(data.session_key || data.sessionKey),
      groupId: normalizeText(data.group_id || data.groupId),
      userId: normalizeText(data.user_id || data.userId),
      updatedAt: updatedAtText,
      ageMs,
      active,
      stale: active && ageMs > staleMs,
      error: normalizeText(data.error).slice(0, 240)
    };
  });
  const countsByStatus = {};
  for (const task of tasks) {
    countsByStatus[task.status] = (countsByStatus[task.status] || 0) + 1;
  }
  const activeTasks = tasks
    .filter((task) => task.active)
    .sort((a, b) => b.ageMs - a.ageMs)
    .slice(0, 20);
  const staleActiveTasks = activeTasks.filter((task) => task.stale);
  return {
    storeDir: target,
    exists: safeStat(target).exists,
    total: tasks.length,
    countsByStatus,
    activeCount: activeTasks.length,
    staleActiveCount: staleActiveTasks.length,
    staleMs,
    activeTasks,
    latestTasks: tasks
      .slice()
      .sort((a, b) => a.ageMs - b.ageMs)
      .slice(0, 10)
  };
}

function buildPostReplyQueueSummary({ queueDir, now, staleProcessingMs }) {
  const target = normalizePath(queueDir);
  const counts = {};
  const samples = {};
  const staleProcessingJobs = [];
  for (const status of POST_REPLY_STATUSES) {
    const dir = path.join(target, status);
    const jobs = readJsonFilesFromDir(dir).map(({ filePath, data }) => {
      const updatedAtText = normalizeText(data.updatedAt || data.updated_at || data.createdAt || data.created_at);
      const updatedAtMs = Date.parse(updatedAtText);
      const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, now - updatedAtMs) : 0;
      return {
        jobId: normalizeText(data.jobId || data.id),
        file: path.basename(filePath),
        status,
        phase: normalizeText(data.phase),
        userId: normalizeText(data.userId || data.user_id),
        attempt: Math.max(0, normalizeNumber(data.attempt, 0)),
        updatedAt: updatedAtText,
        ageMs,
        stale: status === 'processing' && ageMs > staleProcessingMs,
        lastError: normalizeText(data.lastError || data.error).slice(0, 240)
      };
    }).sort((a, b) => a.ageMs - b.ageMs);
    counts[status] = jobs.length;
    samples[status] = jobs.slice(0, status === 'done' ? 3 : 5);
    staleProcessingJobs.push(...jobs.filter((job) => job.stale));
  }
  return {
    queueDir: target,
    exists: safeStat(target).exists,
    counts,
    staleProcessingMs,
    staleProcessingCount: staleProcessingJobs.length,
    staleProcessingJobs,
    samples
  };
}

function getSubagentRuntimeSnapshots() {
  const fallback = {
    executor: null,
    persistentWorkers: [],
    persistentWorkerStats: null,
    snapshotScope: 'current_process_only'
  };
  try {
    const executor = require('../api/subagentExecutor');
    if (typeof executor.getSubagentExecutorSnapshot === 'function') {
      fallback.executor = executor.getSubagentExecutorSnapshot();
    }
  } catch (_) {}
  try {
    const commandBackend = require('../api/subagentBackends/commandBackend');
    if (typeof commandBackend.getPersistentWorkerSnapshot === 'function') {
      fallback.persistentWorkers = commandBackend.getPersistentWorkerSnapshot();
    }
    if (commandBackend.__persistentWorkerStats) {
      fallback.persistentWorkerStats = { ...commandBackend.__persistentWorkerStats };
    }
  } catch (_) {}
  return fallback;
}

function buildSubagentSummary(processes = []) {
  const snapshots = getSubagentRuntimeSnapshots();
  const osProcesses = processes
    .filter(processMatchesSubagent)
    .map(compactProcess)
    .slice(0, 20);
  return {
    enabled: config.SUBAGENT_ENABLED === true,
    backend: normalizeText(config.SUBAGENT_BACKEND || 'command'),
    commandMode: normalizeText(config.SUBAGENT_COMMAND_MODE || ''),
    maxConcurrency: Math.max(1, normalizeNumber(config.SUBAGENT_MAX_CONCURRENCY, 1)),
    processes: osProcesses,
    processCount: osProcesses.length,
    executor: snapshots.executor,
    persistentWorkers: snapshots.persistentWorkers,
    persistentWorkerStats: snapshots.persistentWorkerStats,
    snapshotScope: snapshots.snapshotScope
  };
}

function addSignal(signals, level, component, code, message, extra = {}) {
  signals.push({
    level,
    component,
    code,
    message,
    ...extra
  });
}

function buildRuntimeStatusDiagnostic(options = {}) {
  const projectRoot = normalizePath(options.projectRoot || path.join(__dirname, '..'));
  const now = nowMs(options);
  const processes = listProcesses(options);
  const alive = typeof options.isProcessAlive === 'function'
    ? (pid) => Boolean(options.isProcessAlive(pid))
    : isProcessAliveDefault;
  const signals = [];

  const singleInstanceLock = buildPidFileStatus({
    name: 'singleInstanceLock',
    filePath: path.join(projectRoot, '.mizukibot.lock'),
    processes,
    isProcessAlive: alive,
    expectedProcess: processMatchesMain,
    now
  });
  const linuxMainPidFile = buildPidFileStatus({
    name: 'linuxMainPidFile',
    filePath: path.join(projectRoot, '.mizukibot.pid'),
    processes,
    isProcessAlive: alive,
    expectedProcess: processMatchesMain,
    now
  });
  const postReplyPidFile = buildPidFileStatus({
    name: 'postReplyWorkerPidFile',
    filePath: path.join(projectRoot, '.mizukibot-postreply-worker.pid'),
    processes,
    isProcessAlive: alive,
    expectedProcess: processMatchesPostReplyWorker,
    now
  });
  const memoryMaterializeLock = buildMemoryMaterializeLock({
    filePath: config.MEMORY_V3_MATERIALIZE_LOCK_FILE,
    isProcessAlive: alive,
    now
  });
  const createAgentRuntime = buildCreateAgentRuntimeState({
    filePath: path.join(config.DATA_DIR, 'create-agent', 'runtime.json'),
    isProcessAlive: alive,
    now
  });

  const mainProcesses = processes.filter(processMatchesMain).map(compactProcess);
  const workerProcesses = processes.filter(processMatchesPostReplyWorker).map(compactProcess);
  const backgroundTaskStaleMs = Math.max(
    1000,
    normalizeNumber(options.backgroundTaskStaleMs || process.env.BACKGROUND_TASK_STALE_MS, DEFAULT_BACKGROUND_TASK_STALE_MS)
  );
  const langGraphV2CheckpointStaleMs = Math.max(
    1000,
    normalizeNumber(
      options.langGraphV2CheckpointStaleMs || process.env.LANGGRAPH_V2_CHECKPOINT_STALE_MS,
      DEFAULT_LANGGRAPH_V2_CHECKPOINT_STALE_MS
    )
  );
  const backgroundTasks = buildBackgroundTaskSummary({
    storeDir: config.BACKGROUND_TASK_STORE_DIR,
    now,
    staleMs: backgroundTaskStaleMs
  });
  const langGraphV2Store = buildLangGraphV2StoreSummary({
    checkpointDir: config.LANGGRAPH_V2_CHECKPOINT_DIR,
    eventDir: config.LANGGRAPH_V2_EVENT_DIR,
    now,
    staleCheckpointMs: langGraphV2CheckpointStaleMs
  });
  const postReplyQueue = buildPostReplyQueueSummary({
    queueDir: config.POST_REPLY_QUEUE_DIR,
    now,
    staleProcessingMs: Math.max(1000, normalizeNumber(config.POST_REPLY_WORKER_STALE_PROCESSING_MS, 5 * 60 * 1000))
  });
  const subagents = buildSubagentSummary(processes);
  const journalHealth = (() => {
    try {
      const { buildJournalHealthSummary } = require('./memory-v3/journalDiagnostics');
      return buildJournalHealthSummary({ limit: Math.max(1, normalizeNumber(options.journalLimit, 5)) });
    } catch (error) {
      return {
        ok: false,
        error: normalizeText(error?.message || error)
      };
    }
  })();

  if (singleInstanceLock.status === 'stale') {
    addSignal(signals, 'warning', 'mainProcess', 'main_lock_stale', 'main lock pid is not alive', { pid: singleInstanceLock.pid });
  } else if (singleInstanceLock.status === 'invalid') {
    addSignal(signals, 'warning', 'mainProcess', 'main_lock_invalid', 'main lock file exists but does not contain a pid');
  }
  if (singleInstanceLock.status === 'mismatch') {
    addSignal(signals, 'warning', 'mainProcess', 'main_lock_pid_mismatch', 'main lock pid is alive but does not look like index.js', { pid: singleInstanceLock.pid });
  }
  if (mainProcesses.length > 1) {
    addSignal(signals, 'warning', 'mainProcess', 'main_process_duplicate', 'multiple index.js processes were found', { count: mainProcesses.length });
  }

  const postReplyExpected = config.POST_REPLY_WORKER_ENABLED === true && config.POST_REPLY_WORKER_INLINE !== true;
  const postReplyDiagnosticsEnabled = postReplyExpected || config.POST_REPLY_WORKER_INLINE === true;
  if (postReplyExpected && postReplyPidFile.status === 'missing' && workerProcesses.length === 0) {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_pid_missing', 'post-reply worker pid file is missing and no worker process was found');
  }
  if (postReplyDiagnosticsEnabled && postReplyPidFile.status === 'stale') {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_pid_stale', 'post-reply worker pid is not alive', { pid: postReplyPidFile.pid });
  }
  if (postReplyDiagnosticsEnabled && postReplyPidFile.status === 'mismatch') {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_pid_mismatch', 'post-reply worker pid is alive but command line does not look like post-reply-worker.js', { pid: postReplyPidFile.pid });
  }
  if (postReplyDiagnosticsEnabled && workerProcesses.length > 1) {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_worker_duplicate', 'multiple post-reply worker processes were found', { count: workerProcesses.length });
  }
  if (postReplyDiagnosticsEnabled && postReplyQueue.staleProcessingCount > 0) {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_processing_stale', 'post-reply processing jobs exceeded stale threshold', { count: postReplyQueue.staleProcessingCount });
  }
  if (postReplyDiagnosticsEnabled && postReplyQueue.counts.failed > 0) {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_failed_jobs', 'post-reply queue has failed jobs', { count: postReplyQueue.counts.failed });
  }

  if (backgroundTasks.staleActiveCount > 0) {
    addSignal(signals, 'warning', 'backgroundTasks', 'background_task_stale', 'active background tasks exceeded stale threshold', { count: backgroundTasks.staleActiveCount });
  }
  if (langGraphV2Store.staleRunningCheckpointCount > 0) {
    addSignal(signals, 'warning', 'langGraphV2', 'langgraph_v2_checkpoint_stale', 'active LangGraph V2 checkpoints exceeded stale threshold', { count: langGraphV2Store.staleRunningCheckpointCount });
  }
  if (langGraphV2Store.invalidCheckpointCount > 0) {
    addSignal(signals, 'warning', 'langGraphV2', 'langgraph_v2_checkpoint_invalid', 'LangGraph V2 checkpoint files could not be parsed', { count: langGraphV2Store.invalidCheckpointCount });
  }
  if (langGraphV2Store.invalidEventFileCount > 0) {
    addSignal(signals, 'warning', 'langGraphV2', 'langgraph_v2_event_file_invalid', 'LangGraph V2 event files could not be parsed as event arrays', { count: langGraphV2Store.invalidEventFileCount });
  }
  if (memoryMaterializeLock.status === 'stale') {
    addSignal(signals, 'warning', 'locks', 'memory_materialize_lock_stale', 'memory materialize lock is stale', { pid: memoryMaterializeLock.pid });
  }
  if (createAgentRuntime.status === 'stale') {
    addSignal(signals, 'warning', 'locks', 'create_agent_runtime_stale', 'create-agent runtime reports active work but owner pid is not alive', { pid: createAgentRuntime.ownerPid });
  }
  if (subagents.persistentWorkers.some((worker) => worker?.broken)) {
    addSignal(signals, 'warning', 'subagents', 'subagent_persistent_worker_broken', 'persistent subagent worker snapshot contains broken workers');
  }
  if (normalizeNumber(subagents.executor?.pendingSubagentRuns, 0) > 0) {
    addSignal(signals, 'warning', 'subagents', 'subagent_executor_queue_pending', 'subagent executor has queued calls', { count: normalizeNumber(subagents.executor?.pendingSubagentRuns, 0) });
  }

  const mainStatus = (() => {
    if (singleInstanceLock.status === 'running' || linuxMainPidFile.status === 'running' || mainProcesses.length > 0) return 'running';
    if (singleInstanceLock.status === 'stale' || linuxMainPidFile.status === 'stale') return 'stale_pid';
    if (singleInstanceLock.status === 'invalid') return 'invalid_lock';
    return 'missing';
  })();
  const postReplyStatus = (() => {
    if (config.POST_REPLY_WORKER_INLINE === true) return 'inline';
    if (postReplyPidFile.status === 'running' || workerProcesses.length > 0) return 'running';
    if (config.POST_REPLY_WORKER_ENABLED !== true) return 'disabled';
    if (postReplyPidFile.status === 'stale') return 'stale_pid';
    if (postReplyPidFile.status === 'invalid') return 'invalid_pid';
    return 'missing';
  })();
  const overallStatus = signals.some((signal) => signal.level === 'critical')
    ? 'critical'
    : (signals.length > 0 ? 'warning' : 'ok');

  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: isoFromMs(now),
    summary: {
      overallStatus,
      signalCount: signals.length,
      signals: signals.map((signal) => signal.code),
      mainProcess: {
        status: mainStatus,
        lockPid: singleInstanceLock.pid || linuxMainPidFile.pid || 0,
        processCount: mainProcesses.length
      },
      postReplyWorker: {
        status: postReplyStatus,
        pid: postReplyPidFile.pid,
        pidFileMatch: postReplyPidFile.status !== 'mismatch',
        processCount: workerProcesses.length,
        queue: postReplyQueue.counts
      },
      activeBackgroundTasks: backgroundTasks.activeCount,
      staleBackgroundTasks: backgroundTasks.staleActiveCount,
      langGraphV2: {
        checkpoints: langGraphV2Store.checkpointCount,
        events: langGraphV2Store.eventFileCount,
        activeCheckpoints: langGraphV2Store.activeCheckpointCount,
        staleRunningCheckpoints: langGraphV2Store.staleRunningCheckpointCount,
        checkpointBytes: langGraphV2Store.totalCheckpointBytes,
        eventBytes: langGraphV2Store.totalEventBytes
      },
      activeSubagentProcesses: subagents.processCount,
      persistentSubagentWorkers: subagents.persistentWorkers.length,
      journalHealth: journalHealth.totals || {}
    },
    components: {
      projectRoot,
      mainProcess: {
        lockFile: singleInstanceLock,
        linuxPidFile: linuxMainPidFile,
        processes: mainProcesses
      },
      postReplyWorker: {
        enabled: config.POST_REPLY_WORKER_ENABLED === true,
        inline: config.POST_REPLY_WORKER_INLINE === true,
        pidFile: postReplyPidFile,
        processes: workerProcesses,
        queue: postReplyQueue
      },
      lockFiles: [
        singleInstanceLock,
        linuxMainPidFile,
        postReplyPidFile,
        memoryMaterializeLock,
        createAgentRuntime
      ],
      backgroundTasks,
      langGraphV2Store,
      subagents,
      journalHealth
    },
    signals
  };
}

function buildRuntimeStatusText(report = {}) {
  const summary = report.summary || {};
  const postQueue = summary.postReplyWorker?.queue || {};
  const langGraphV2 = summary.langGraphV2 || {};
  const lines = [
    `runtime: ${summary.overallStatus || 'unknown'} (${summary.signalCount || 0} signals)`,
    `main: ${summary.mainProcess?.status || 'unknown'} pid=${summary.mainProcess?.lockPid || 0} processes=${summary.mainProcess?.processCount || 0}`,
    `post-reply: ${summary.postReplyWorker?.status || 'unknown'} pid=${summary.postReplyWorker?.pid || 0} processes=${summary.postReplyWorker?.processCount || 0} queue=queued:${postQueue.queued || 0} processing:${postQueue.processing || 0} failed:${postQueue.failed || 0}`,
    `background-tasks: active=${summary.activeBackgroundTasks || 0} stale=${summary.staleBackgroundTasks || 0}`,
    `langgraph-v2: checkpoints=${langGraphV2.checkpoints || 0} active=${langGraphV2.activeCheckpoints || 0} stale=${langGraphV2.staleRunningCheckpoints || 0} events=${langGraphV2.events || 0}`,
    `subagents: osProcesses=${summary.activeSubagentProcesses || 0} persistentWorkers=${summary.persistentSubagentWorkers || 0}`
  ];
  const journal = summary.journalHealth || {};
  if (Object.keys(journal).length > 0) {
    lines.push(`journal: users=${journal.users || 0} days=${journal.days || 0} summaries=${journal.summaryDays || 0} segments=${journal.segments || 0} v3Events=${journal.v3EpisodeEvents || 0} embeddingReady=${journal.embeddingReady || 0} pending=${journal.embeddingPending || 0} failed=${journal.embeddingFailed || 0}`);
  }
  if (Array.isArray(report.signals) && report.signals.length > 0) {
    lines.push('signals:');
    for (const signal of report.signals) {
      lines.push(`- [${signal.level}] ${signal.component}/${signal.code}: ${signal.message}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  buildRuntimeStatusDiagnostic,
  buildRuntimeStatusText,
  isProcessAliveDefault,
  listProcessesDefault
};

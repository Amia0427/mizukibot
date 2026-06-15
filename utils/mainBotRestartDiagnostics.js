const fs = require('fs');
const path = require('path');
const {
  compactProcess,
  findProcessByPid,
  isProcessAliveDefault,
  listProcesses,
  normalizePid,
  processMatchesMain
} = require('./runtimeStatusDiagnostics/processes');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCHEMA_VERSION = 'main_bot_restart_diagnostic_v1';
const DEFAULT_MAX_ARCHIVE_LOGS = 2;
const DEFAULT_TAIL_LINES = 30;
const DEFAULT_DAEMON_EVENTS = 16;
const DEFAULT_EXIT_OBSERVATIONS = 12;
const DEFAULT_LOG_TAIL_BYTES = 512 * 1024;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function isoFromMs(value = 0) {
  const ms = normalizeNumber(value, 0);
  return ms > 0 ? new Date(ms).toISOString() : '';
}

function parseTimeMs(value = '') {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeStat(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      isFile: stat.isFile(),
      mtimeMs: normalizeNumber(stat.mtimeMs, 0),
      size: normalizeNumber(stat.size, 0)
    };
  } catch (_) {
    return {
      exists: false,
      isFile: false,
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
    const raw = safeReadText(filePath).replace(/^\uFEFF/, '');
    if (!normalizeText(raw)) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function readRecentJsonLines(filePath = '', options = {}) {
  const target = normalizePath(filePath);
  const maxLines = Math.max(1, Math.floor(normalizeNumber(options.maxLines, DEFAULT_EXIT_OBSERVATIONS)));
  const maxBytes = Math.max(4096, Math.floor(normalizeNumber(options.maxBytes, DEFAULT_LOG_TAIL_BYTES)));
  const raw = readTailText(target, maxBytes);
  if (!normalizeText(raw)) return [];
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .slice(-Math.max(maxLines * 4, maxLines))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter((row) => row && typeof row === 'object')
    .slice(-maxLines);
}

function safeReadDir(dirPath = '') {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function readTailText(filePath = '', maxBytes = DEFAULT_LOG_TAIL_BYTES) {
  const target = normalizePath(filePath);
  const stat = safeStat(target);
  if (!stat.exists || !stat.isFile || stat.size <= 0) return '';
  const bytes = Math.max(1, Math.floor(normalizeNumber(maxBytes, DEFAULT_LOG_TAIL_BYTES)));
  const start = Math.max(0, stat.size - bytes);
  const length = stat.size - start;
  let fd = null;
  try {
    fd = fs.openSync(target, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
}

function tailLines(text = '', maxLines = DEFAULT_TAIL_LINES) {
  const limit = Math.max(0, Math.floor(normalizeNumber(maxLines, DEFAULT_TAIL_LINES)));
  if (limit <= 0) return [];
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => normalizeText(line))
    .slice(-limit);
}

function readFirstLine(filePath = '') {
  const raw = safeReadText(filePath);
  return String(raw || '').split(/\r?\n/)[0] || '';
}

function buildLockStatus(options = {}) {
  const projectRoot = normalizePath(options.projectRoot || PROJECT_ROOT);
  const lockPath = path.join(projectRoot, '.mizukibot.lock');
  const now = normalizeNumber(options.nowMs, Date.now());
  const stat = safeStat(lockPath);
  const raw = stat.exists ? readFirstLine(lockPath) : '';
  const pid = normalizePid(raw);
  const processes = Array.isArray(options.processes) ? options.processes : listProcesses(options);
  const alive = typeof options.isProcessAlive === 'function'
    ? (targetPid) => Boolean(options.isProcessAlive(targetPid))
    : isProcessAliveDefault;
  const processAlive = pid > 0 ? alive(pid) : false;
  const proc = findProcessByPid(processes, pid);
  const hasCommandLine = Boolean(normalizeText(proc?.commandLine));
  const commandLineMatches = proc ? processMatchesMain(proc, projectRoot) : false;
  let status = 'missing';
  if (stat.exists && !pid) status = 'invalid';
  if (stat.exists && pid && !processAlive) status = 'stale';
  if (stat.exists && pid && processAlive) {
    status = commandLineMatches || !hasCommandLine ? 'running' : 'mismatch';
  }
  return {
    path: lockPath,
    exists: stat.exists,
    status,
    pid,
    raw: normalizeText(raw),
    processAlive,
    commandLineMatches,
    mtime: isoFromMs(stat.mtimeMs),
    ageMs: stat.mtimeMs > 0 ? Math.max(0, now - stat.mtimeMs) : 0,
    size: stat.size,
    process: compactProcess(proc)
  };
}

function buildExpectedShutdownMarker(dataDir = '', now = Date.now()) {
  const markerPath = path.join(dataDir, 'bot-main-expected-shutdown.json');
  const stat = safeStat(markerPath);
  const parsed = safeReadJson(markerPath, null);
  const expiresAtMs = parseTimeMs(parsed?.expiresAt);
  return {
    path: markerPath,
    exists: stat.exists,
    active: expiresAtMs > now,
    pid: normalizePid(parsed?.pid),
    reason: normalizeText(parsed?.reason),
    expiresAt: normalizeText(parsed?.expiresAt),
    mtime: isoFromMs(stat.mtimeMs),
    size: stat.size
  };
}

function normalizeRestartState(rawState = null, statePath = '', now = Date.now()) {
  const stat = safeStat(statePath);
  const state = rawState && typeof rawState === 'object' ? rawState : {};
  const cooldownUntilMs = parseTimeMs(state.cooldownUntil);
  return {
    path: statePath,
    exists: stat.exists,
    firstExitAt: normalizeText(state.firstExitAt),
    lastExitAt: normalizeText(state.lastExitAt),
    count: Math.max(0, Math.floor(normalizeNumber(state.count, 0))),
    cooldownUntil: normalizeText(state.cooldownUntil),
    cooldownActive: cooldownUntilMs > now,
    lastPid: normalizePid(state.lastPid),
    lastReason: normalizeText(state.lastReason),
    lockAgeMs: Math.max(0, Math.floor(normalizeNumber(state.lockAgeMs, 0))),
    effectiveRuntimeMs: Math.max(0, Math.floor(normalizeNumber(state.effectiveRuntimeMs ?? state.effectiveExitAgeMs, 0))),
    runtimeAgeSource: normalizeText(state.runtimeAgeSource || state.exitAgeSource),
    heartbeatAt: normalizeText(state.heartbeatAt),
    startedAt: normalizeText(state.startedAt),
    windowMs: Math.max(0, Math.floor(normalizeNumber(state.windowMs, 0))),
    maxRestarts: Math.max(0, Math.floor(normalizeNumber(state.maxRestarts, 0))),
    cooldownMs: Math.max(0, Math.floor(normalizeNumber(state.cooldownMs, 0))),
    mtime: isoFromMs(stat.mtimeMs),
    size: stat.size
  };
}

function normalizeExitObservation(row = {}) {
  const observedAt = normalizeText(row.observedAt || row.at || row.timestamp);
  return {
    schemaVersion: normalizeText(row.schemaVersion),
    source: normalizeText(row.source),
    event: normalizeText(row.event || row.type),
    observedAt,
    observedAtMs: parseTimeMs(observedAt),
    pid: normalizePid(row.pid || row.ownerPid),
    reason: normalizeText(row.reason),
    earlyExitReason: normalizeText(row.earlyExitReason),
    earlyExitCount: Math.max(0, Math.floor(normalizeNumber(row.earlyExitCount, 0))),
    cooldownUntil: normalizeText(row.cooldownUntil),
    lockAgeMs: Math.max(0, Math.floor(normalizeNumber(row.lockAgeMs, 0))),
    heartbeatAgeMs: Math.max(0, Math.floor(normalizeNumber(row.heartbeatAgeMs, 0))),
    runtimeMs: Math.max(0, Math.floor(normalizeNumber(row.runtimeMs || row.effectiveRuntimeMs || row.effectiveAgeMs, 0))),
    ageSource: normalizeText(row.ageSource || row.runtimeAgeSource),
    heartbeatAt: normalizeText(row.heartbeatAt),
    startedAt: normalizeText(row.startedAt),
    runtimeStateStage: normalizeText(row.runtimeStateStage || row.stage),
    lockDiagnostics: normalizeText(row.lockDiagnostics).slice(0, 500),
    message: normalizeText(row.message).slice(0, 500),
    reportPath: normalizeText(row.reportPath)
  };
}

function buildExitObservations(dataDir = '', options = {}) {
  const filePath = normalizePath(options.exitObservationsFile || path.join(dataDir, 'bot-main-exit-observations.jsonl'));
  const stat = safeStat(filePath);
  const maxLines = Math.max(1, Math.floor(normalizeNumber(options.maxExitObservations, DEFAULT_EXIT_OBSERVATIONS)));
  const rows = readRecentJsonLines(filePath, {
    maxLines,
    maxBytes: Math.max(4096, Math.floor(normalizeNumber(options.exitObservationsTailBytes, DEFAULT_LOG_TAIL_BYTES)))
  }).map(normalizeExitObservation)
    .filter((row) => row.event || row.source || row.pid)
    .sort((a, b) => b.observedAtMs - a.observedAtMs);

  return {
    path: filePath,
    exists: stat.exists,
    size: stat.size,
    latestAt: rows[0]?.observedAt || '',
    latestPid: rows[0]?.pid || 0,
    rows
  };
}

function isRuntimeArchiveName(name = '') {
  const text = normalizeText(name);
  return /^bot-runtime\.(out|err)\..+\.log$/i.test(text);
}

function runtimeStreamFromName(name = '') {
  const match = normalizeText(name).match(/^bot-runtime\.(out|err)\./i);
  if (!match) return '';
  return match[1].toLowerCase() === 'out' ? 'stdout' : 'stderr';
}

function buildRuntimeArchiveItem(filePath = '', stream = '', options = {}) {
  const target = normalizePath(filePath);
  const stat = safeStat(target);
  if (!stat.exists || !stat.isFile) return null;
  const tailLineCount = Math.max(0, Math.floor(normalizeNumber(options.tailLines, DEFAULT_TAIL_LINES)));
  const maxBytes = Math.max(4096, Math.floor(normalizeNumber(options.logTailBytes, DEFAULT_LOG_TAIL_BYTES)));
  return {
    path: target,
    file: path.basename(target),
    stream,
    mtime: isoFromMs(stat.mtimeMs),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    tail: tailLines(readTailText(target, maxBytes), tailLineCount)
  };
}

function listRuntimeArchives(dataDir = '', options = {}) {
  const targetDir = normalizePath(dataDir);
  const maxArchiveLogs = Math.max(1, Math.floor(normalizeNumber(options.maxArchiveLogs, DEFAULT_MAX_ARCHIVE_LOGS)));
  const tailLineCount = Math.max(0, Math.floor(normalizeNumber(options.tailLines, DEFAULT_TAIL_LINES)));
  const maxBytes = Math.max(4096, Math.floor(normalizeNumber(options.logTailBytes, DEFAULT_LOG_TAIL_BYTES)));
  const grouped = {
    stdout: [],
    stderr: []
  };
  const seen = new Set();
  for (const archivePath of Array.isArray(options.preferredArchivePaths) ? options.preferredArchivePaths : []) {
    const filePath = normalizePath(archivePath);
    const file = path.basename(filePath);
    if (!isRuntimeArchiveName(file)) continue;
    const stream = runtimeStreamFromName(file);
    if (!stream) continue;
    const item = buildRuntimeArchiveItem(filePath, stream, { tailLines: tailLineCount, logTailBytes: maxBytes });
    if (!item) continue;
    seen.add(item.path.toLowerCase());
    grouped[stream].push({
      ...item,
      preferredByDaemonLog: true
    });
  }
  for (const entry of safeReadDir(targetDir)) {
    if (!entry.isFile() || !isRuntimeArchiveName(entry.name)) continue;
    const stream = runtimeStreamFromName(entry.name);
    if (!stream) continue;
    const filePath = path.join(targetDir, entry.name);
    if (seen.has(normalizePath(filePath).toLowerCase())) continue;
    const item = buildRuntimeArchiveItem(filePath, stream, { tailLines: tailLineCount, logTailBytes: maxBytes });
    if (item) grouped[stream].push(item);
  }
  for (const stream of Object.keys(grouped)) {
    grouped[stream] = grouped[stream]
      .sort((a, b) => {
        if (a.preferredByDaemonLog !== b.preferredByDaemonLog) return a.preferredByDaemonLog ? -1 : 1;
        return b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file);
      })
      .slice(0, maxArchiveLogs)
      .map((item) => ({ ...item }));
  }
  return grouped;
}

function buildActiveRuntimeLogs(dataDir = '') {
  return ['bot-runtime.out.log', 'bot-runtime.err.log'].map((name) => {
    const filePath = path.join(dataDir, name);
    const stat = safeStat(filePath);
    return {
      path: filePath,
      file: name,
      stream: name.includes('.out.') ? 'stdout' : 'stderr',
      exists: stat.exists,
      mtime: isoFromMs(stat.mtimeMs),
      size: stat.size
    };
  });
}

function parseDaemonTimestamp(line = '') {
  const match = String(line || '').match(/^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
  if (!match) {
    return { at: '', atMs: 0, message: normalizeText(line) };
  }
  const localText = `${match[1]} ${match[2]}`;
  const parsed = Date.parse(`${match[1]}T${match[2]}`);
  return {
    at: localText,
    atMs: Number.isFinite(parsed) ? parsed : 0,
    message: normalizeText(match[3])
  };
}

function classifyDaemonMessage(message = '') {
  const text = normalizeText(message);
  if (/^started main bot pid=/i.test(text)) return 'main_bot_started';
  if (/^main bot lock acquired after daemon start/i.test(text)) return 'main_bot_lock_acquired';
  if (/^lock present but not owned by active main bot/i.test(text)) return 'stale_lock_detected';
  if (/^main bot early-exit state updated/i.test(text)) return 'early_exit_state_updated';
  if (/main bot exited repeatedly soon after startup; backoff active/i.test(text)) return 'early_exit_backoff_active';
  if (/main bot did not acquire lock after daemon start/i.test(text)) return 'main_bot_lock_handoff_failed';
  if (/^archived runtime redirect log before restart/i.test(text)) return 'runtime_log_archived';
  if (/^bot already running, skip duplicate start/i.test(text)) return 'main_bot_already_running';
  return '';
}

function extractPid(message = '') {
  const match = normalizeText(message).match(/\b(?:pid|started_pid|previous_pid|lock pid)=([0-9]+)/i);
  return match ? normalizePid(match[1]) : 0;
}

function extractDaemonArchivePath(message = '') {
  const match = normalizeText(message).match(/\barchive=(.+)$/i);
  return match ? normalizeText(match[1]) : '';
}

function parseDaemonEvents(dataDir = '', options = {}) {
  const logPath = normalizePath(options.daemonLogFile || path.join(dataDir, 'bot-daemon.log'));
  const maxEvents = Math.max(1, Math.floor(normalizeNumber(options.maxDaemonEvents, DEFAULT_DAEMON_EVENTS)));
  const maxBytes = Math.max(4096, Math.floor(normalizeNumber(options.daemonTailBytes, DEFAULT_LOG_TAIL_BYTES)));
  const raw = readTailText(logPath, maxBytes);
  const events = String(raw || '').split(/\r?\n/)
    .map((line) => {
      const parsed = parseDaemonTimestamp(line);
      const type = classifyDaemonMessage(parsed.message);
      if (!type) return null;
      return {
        type,
        at: parsed.at,
        atMs: parsed.atMs,
        message: parsed.message,
        pid: extractPid(parsed.message),
        archivePath: type === 'runtime_log_archived' ? extractDaemonArchivePath(parsed.message) : ''
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.atMs - a.atMs);
  const archivePaths = events
    .filter((event) => event.type === 'runtime_log_archived' && normalizeText(event.archivePath))
    .map((event) => event.archivePath);
  const latestMainBotStart = events.find((event) => event.type === 'main_bot_started') || null;
  const latestLockHandoff = events.find((event) => event.type === 'main_bot_lock_acquired') || null;
  return {
    path: logPath,
    exists: safeStat(logPath).exists,
    latestMainBotStartAt: latestMainBotStart?.at || '',
    latestMainBotStartPid: latestMainBotStart?.pid || 0,
    latestLockHandoffAt: latestLockHandoff?.at || '',
    latestLockHandoffPid: latestLockHandoff?.pid || 0,
    archivePaths,
    events: events.slice(0, maxEvents)
  };
}

function daemonEventShowsHardExit(event = {}) {
  const message = normalizeText(event.message);
  return event.type === 'early_exit_state_updated'
    && /reason=(counted|threshold_reached)/i.test(message);
}

function daemonEventShowsSilentStaleLock(event = {}) {
  const message = normalizeText(event.message);
  return event.type === 'stale_lock_detected'
    && /\block pid=\d+/i.test(message)
    && /(not running|start_matches_lock=False|name=(?!node\b))/i.test(message);
}

function observationShowsHardExit(row = {}) {
  return row.event === 'daemon_stale_lock'
    && (row.earlyExitReason === 'counted' || row.earlyExitReason === 'threshold_reached');
}

function addSignal(signals, level, code, message, extra = {}) {
  signals.push({
    level,
    code,
    message,
    ...extra
  });
}

function buildMainBotRestartDiagnostic(options = {}) {
  const projectRoot = normalizePath(options.projectRoot || process.env.MIZUKIBOT_PROJECT_ROOT || PROJECT_ROOT);
  const dataDir = normalizePath(options.dataDir || process.env.DATA_DIR || path.join(projectRoot, 'data'));
  const now = nowMs(options);
  const processes = Array.isArray(options.processes) ? options.processes : listProcesses(options);
  const statePath = normalizePath(options.restartStateFile || path.join(dataDir, 'bot-main-restart-state.json'));
  const restartState = normalizeRestartState(safeReadJson(statePath, null), statePath, now);
  const lock = buildLockStatus({
    ...options,
    projectRoot,
    nowMs: now,
    processes
  });
  const daemon = parseDaemonEvents(dataDir, options);
  const exitObservations = buildExitObservations(dataDir, options);
  const preferredArchivePaths = Array.isArray(daemon.archivePaths) ? daemon.archivePaths : [];
  const runtimeArchives = listRuntimeArchives(dataDir, {
    ...options,
    preferredArchivePaths
  });
  const activeRuntimeLogs = buildActiveRuntimeLogs(dataDir);
  const expectedShutdown = buildExpectedShutdownMarker(dataDir, now);
  const signals = [];

  if (restartState.cooldownActive) {
    addSignal(signals, 'warning', 'main_bot_restart_cooldown_active', 'main bot early-exit cooldown is active', {
      cooldownUntil: restartState.cooldownUntil,
      count: restartState.count
    });
  } else if (restartState.count > 0) {
    addSignal(signals, 'info', 'main_bot_restart_state_present', 'main bot early-exit state has recent evidence', {
      count: restartState.count,
      lastReason: restartState.lastReason
    });
  }
  if (lock.status === 'stale') {
    addSignal(signals, 'warning', 'main_bot_lock_stale', '.mizukibot.lock pid is not alive', { pid: lock.pid });
  } else if (lock.status === 'mismatch') {
    addSignal(signals, 'warning', 'main_bot_lock_mismatch', '.mizukibot.lock pid is alive but does not look like node index.js', { pid: lock.pid });
  } else if (lock.status === 'invalid') {
    addSignal(signals, 'warning', 'main_bot_lock_invalid', '.mizukibot.lock does not contain a valid pid');
  }
  if (runtimeArchives.stdout.length === 0 && runtimeArchives.stderr.length === 0) {
    addSignal(signals, 'info', 'main_bot_runtime_archives_missing', 'no archived bot-runtime stdout/stderr logs were found');
  }
  if (!daemon.latestMainBotStartAt) {
    addSignal(signals, 'info', 'main_bot_daemon_restart_missing', 'no recent daemon main-bot start event was found in bot-daemon.log');
  }
  const hardExitDaemonEvent = daemon.events.find(daemonEventShowsHardExit);
  if (hardExitDaemonEvent) {
    addSignal(signals, 'warning', 'main_bot_hard_exit_counted_by_daemon', 'daemon counted a recent main-bot exit while the lock was still owned', {
      pid: hardExitDaemonEvent.pid,
      at: hardExitDaemonEvent.at,
      event: hardExitDaemonEvent.message
    });
  }
  const staleLockDaemonEvent = daemon.events.find(daemonEventShowsSilentStaleLock);
  if (staleLockDaemonEvent && !hardExitDaemonEvent) {
    addSignal(signals, 'warning', 'main_bot_stale_lock_observed_by_daemon', 'daemon observed a dead or mismatched main-bot lock owner', {
      pid: staleLockDaemonEvent.pid,
      at: staleLockDaemonEvent.at,
      event: staleLockDaemonEvent.message
    });
  }
  const hardExitObservation = exitObservations.rows.find(observationShowsHardExit);
  if (hardExitObservation) {
    addSignal(signals, 'warning', 'main_bot_hard_exit_observation_recorded', 'exit observations contain a daemon-confirmed hard exit', {
      pid: hardExitObservation.pid,
      observedAt: hardExitObservation.observedAt,
      runtimeMs: hardExitObservation.runtimeMs,
      ageSource: hardExitObservation.ageSource,
      earlyExitReason: hardExitObservation.earlyExitReason
    });
  }

  const overallStatus = signals.some((signal) => signal.level === 'warning')
    ? 'warning'
    : 'ok';

  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: isoFromMs(now),
    summary: {
      overallStatus,
      restartCount: restartState.count,
      lastExitAt: restartState.lastExitAt,
      lastReason: restartState.lastReason,
      cooldownActive: restartState.cooldownActive,
      cooldownUntil: restartState.cooldownUntil,
      lockStatus: lock.status,
      lockPid: lock.pid,
      latestMainBotStartAt: daemon.latestMainBotStartAt,
      latestMainBotStartPid: daemon.latestMainBotStartPid,
      latestLockHandoffAt: daemon.latestLockHandoffAt,
      archiveCounts: {
        stdout: runtimeArchives.stdout.length,
        stderr: runtimeArchives.stderr.length
      },
      signalCount: signals.length,
      signals: signals.map((signal) => signal.code)
    },
    inputs: {
      projectRoot,
      dataDir,
      restartStateFile: statePath,
      daemonLogFile: daemon.path,
      exitObservationsFile: exitObservations.path
    },
    restartState,
    lock,
    expectedShutdown,
    exitObservations,
    daemon,
    runtimeLogs: {
      active: activeRuntimeLogs,
      archived: runtimeArchives
    },
    signals
  };
}

function formatMs(ms = 0) {
  const value = Math.max(0, Math.floor(normalizeNumber(ms, 0)));
  if (value >= 60 * 60 * 1000) return `${Math.round(value / (60 * 60 * 1000))}h`;
  if (value >= 60 * 1000) return `${Math.round(value / (60 * 1000))}m`;
  if (value >= 1000) return `${Math.round(value / 1000)}s`;
  return `${value}ms`;
}

function appendLogSection(lines, title, logs = []) {
  lines.push(`${title}:`);
  if (!Array.isArray(logs) || logs.length === 0) {
    lines.push('- none');
    return;
  }
  for (const log of logs) {
    lines.push(`- ${log.file} mtime=${log.mtime || '-'} size=${log.size || 0}`);
    if (Array.isArray(log.tail) && log.tail.length > 0) {
      for (const line of log.tail) {
        lines.push(`  ${String(line).slice(0, 240)}`);
      }
    }
  }
}

function buildMainBotRestartText(report = {}) {
  const summary = report.summary || {};
  const restartState = report.restartState || {};
  const lock = report.lock || {};
  const expected = report.expectedShutdown || {};
  const daemon = report.daemon || {};
  const exitObservations = report.exitObservations || {};
  const archived = report.runtimeLogs?.archived || {};
  const lines = [
    `main-bot-restarts: ${summary.overallStatus || 'unknown'} (${summary.signalCount || 0} signals)`,
    `state: count=${restartState.count || 0} lastExit=${restartState.lastExitAt || '-'} reason=${restartState.lastReason || '-'} cooldownActive=${restartState.cooldownActive ? 'yes' : 'no'} cooldownUntil=${restartState.cooldownUntil || '-'}`,
    `runtime-evidence: started=${restartState.startedAt || '-'} heartbeat=${restartState.heartbeatAt || '-'} effectiveRuntime=${restartState.effectiveRuntimeMs ? formatMs(restartState.effectiveRuntimeMs) : '-'} source=${restartState.runtimeAgeSource || '-'}`,
    `policy: window=${restartState.windowMs ? formatMs(restartState.windowMs) : '-'} maxRestarts=${restartState.maxRestarts || 0} cooldown=${restartState.cooldownMs ? formatMs(restartState.cooldownMs) : '-'}`,
    `lock: ${lock.status || 'unknown'} pid=${lock.pid || 0} alive=${lock.processAlive ? 'yes' : 'no'} age=${lock.ageMs ? formatMs(lock.ageMs) : '-'} path=${lock.path || '-'}`,
    `expected-shutdown: exists=${expected.exists ? 'yes' : 'no'} active=${expected.active ? 'yes' : 'no'} pid=${expected.pid || 0} reason=${expected.reason || '-'}`,
    `daemon: latestStart=${daemon.latestMainBotStartAt || '-'} pid=${daemon.latestMainBotStartPid || 0} latestLockHandoff=${daemon.latestLockHandoffAt || '-'}`
  ];

  if (lock.process?.commandLine) {
    lines.push(`lock-process: ${lock.process.commandLine}`);
  }

  if (Array.isArray(daemon.events) && daemon.events.length > 0) {
    lines.push('daemon-events:');
    for (const event of daemon.events) {
      lines.push(`- ${event.at || '-'} ${event.type}${event.pid ? ` pid=${event.pid}` : ''}: ${event.message}`);
    }
  }

  if (Array.isArray(exitObservations.rows) && exitObservations.rows.length > 0) {
    lines.push('exit-observations:');
    for (const row of exitObservations.rows) {
      const parts = [
        row.observedAt || '-',
        row.source || 'unknown',
        row.event || 'event',
        row.pid ? `pid=${row.pid}` : '',
        row.earlyExitReason ? `early=${row.earlyExitReason}` : '',
        row.runtimeMs ? `runtime=${formatMs(row.runtimeMs)}` : '',
        row.ageSource ? `source=${row.ageSource}` : '',
        row.reason ? `reason=${row.reason}` : ''
      ].filter(Boolean);
      lines.push(`- ${parts.join(' ')}`);
      if (row.lockDiagnostics) {
        lines.push(`  ${row.lockDiagnostics}`);
      } else if (row.message) {
        lines.push(`  ${row.message}`);
      }
    }
  }

  appendLogSection(lines, 'archived-stdout', archived.stdout || []);
  appendLogSection(lines, 'archived-stderr', archived.stderr || []);

  if (Array.isArray(report.signals) && report.signals.length > 0) {
    lines.push('signals:');
    for (const signal of report.signals) {
      lines.push(`- [${signal.level}] ${signal.code}: ${signal.message}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  buildMainBotRestartDiagnostic,
  buildMainBotRestartText,
  classifyDaemonMessage,
  buildExitObservations,
  listRuntimeArchives,
  parseDaemonEvents,
  parseDaemonTimestamp
};

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCHEMA_VERSION = 'main_bot_stability_window_v1';
const DEFAULT_START = '2026-06-15T23:19:00+08:00';
const DEFAULT_END = '2026-06-16T03:49:59+08:00';
const DEFAULT_EXPECTED_PID = 38172;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseTimeMs(value = '') {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoFromMs(ms = 0) {
  const value = normalizeNumber(ms, 0);
  return value > 0 ? new Date(value).toISOString() : '';
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

function parseDaemonTimestamp(line = '') {
  const match = String(line || '').match(/^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
  if (!match) return { at: '', atMs: 0, message: normalizeText(line) };
  const localText = `${match[1]} ${match[2]}`;
  const atMs = Date.parse(`${match[1]}T${match[2]}+08:00`);
  return {
    at: localText,
    atMs: Number.isFinite(atMs) ? atMs : 0,
    message: normalizeText(match[3])
  };
}

function extractPid(message = '') {
  const match = normalizeText(message).match(/\b(?:pid|started_pid|previous_pid|lock pid)=([0-9]+)/i);
  return match ? Math.max(0, Math.floor(normalizeNumber(match[1], 0))) : 0;
}

function classifyWindowDaemonMessage(message = '') {
  const text = normalizeText(message);
  if (/^started main bot pid=/i.test(text)) return 'main_bot_started';
  if (/^main bot lock acquired after daemon start/i.test(text)) return 'main_bot_lock_acquired';
  if (/^bot already running, skip duplicate start/i.test(text)) return 'main_bot_already_running';
  if (/^lock present but not owned by active main bot/i.test(text)) return 'stale_lock_detected';
  if (/^main bot early-exit state updated/i.test(text)) return 'early_exit_state_updated';
  if (/main bot exited repeatedly soon after startup; backoff active/i.test(text)) return 'early_exit_backoff_active';
  if (/main bot did not acquire lock after daemon start/i.test(text)) return 'main_bot_lock_handoff_failed';
  if (/^daemon task error:/i.test(text)) return 'daemon_task_error';
  if (/^daemon task exited with code /i.test(text)) return 'daemon_task_exited';
  return '';
}

function readDaemonWindowEvents(logPath = '', startMs = 0, endMs = 0) {
  return safeReadText(logPath)
    .split(/\r?\n/)
    .map((line) => {
      const parsed = parseDaemonTimestamp(line);
      if (!parsed.atMs || parsed.atMs < startMs || parsed.atMs > endMs) return null;
      const type = classifyWindowDaemonMessage(parsed.message);
      if (!type) return null;
      return {
        at: parsed.at,
        atMs: parsed.atMs,
        type,
        pid: extractPid(parsed.message),
        message: parsed.message
      };
    })
    .filter(Boolean);
}

function summarizePid(events = []) {
  const starts = events.filter((event) => event.type === 'main_bot_started');
  const handoffs = events.filter((event) => event.type === 'main_bot_lock_acquired');
  const alreadyRunning = events.filter((event) => event.type === 'main_bot_already_running');
  const pidSet = new Set(
    [...starts, ...handoffs, ...alreadyRunning]
      .map((event) => event.pid)
      .filter((pid) => pid > 0)
  );
  return {
    pids: Array.from(pidSet).sort((a, b) => a - b),
    starts,
    handoffs,
    alreadyRunning
  };
}

function buildMainBotStabilityWindowReport(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const dataDir = path.resolve(options.dataDir || path.join(projectRoot, 'data'));
  const daemonLogFile = path.resolve(options.daemonLogFile || path.join(dataDir, 'bot-daemon.log'));
  const runtimeStateFile = path.resolve(options.runtimeStateFile || path.join(dataDir, 'bot-main-runtime-state.json'));
  const restartStateFile = path.resolve(options.restartStateFile || path.join(dataDir, 'bot-main-restart-state.json'));
  const start = normalizeText(options.start || DEFAULT_START);
  const end = normalizeText(options.end || DEFAULT_END);
  const startMs = parseTimeMs(start);
  const endMs = parseTimeMs(end);
  const expectedPid = Math.max(0, Math.floor(normalizeNumber(options.expectedPid, DEFAULT_EXPECTED_PID)));
  const runtimeState = safeReadJson(runtimeStateFile, {});
  const restartState = safeReadJson(restartStateFile, {});
  const events = startMs && endMs ? readDaemonWindowEvents(daemonLogFile, startMs, endMs) : [];
  const pidSummary = summarizePid(events);
  const blockingTypes = new Set([
    'early_exit_backoff_active',
    'main_bot_lock_handoff_failed',
    'daemon_task_error'
  ]);
  const blockingEvents = events.filter((event) => {
    if (blockingTypes.has(event.type)) return true;
    return event.type === 'early_exit_state_updated' && /reason=(counted|threshold_reached)/i.test(event.message);
  });
  const failures = [];

  if (!startMs || !endMs || startMs >= endMs) failures.push('invalid_window');
  if (pidSummary.starts.length !== 1) failures.push('window_requires_exactly_one_main_bot_start');
  if (expectedPid && !pidSummary.pids.includes(expectedPid)) failures.push('expected_pid_not_observed');
  if (expectedPid && pidSummary.pids.some((pid) => pid !== expectedPid)) failures.push('unexpected_main_bot_pid_observed');
  if (pidSummary.alreadyRunning.length < 3) failures.push('insufficient_daemon_already_running_checks');
  if (blockingEvents.length > 0) failures.push('blocking_daemon_event_in_window');
  if (normalizeNumber(runtimeState.pid, 0) === expectedPid && parseTimeMs(runtimeState.startedAt) > startMs) failures.push('runtime_state_started_after_window_start');
  if (parseTimeMs(runtimeState.heartbeatAt) <= endMs) failures.push('runtime_state_heartbeat_not_after_window_end');
  if (normalizeNumber(restartState.count, 0) !== 0) failures.push('restart_state_count_not_zero');
  if (normalizeText(restartState.cooldownUntil)) failures.push('restart_state_cooldown_not_empty');

  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: isoFromMs(typeof options.now === 'function' ? options.now() : Date.now()),
    status: failures.length > 0 ? 'fail' : 'pass',
    failures,
    window: { start, end, startUtc: isoFromMs(startMs), endUtc: isoFromMs(endMs) },
    expectedPid,
    inputs: { daemonLogFile, runtimeStateFile, restartStateFile },
    summary: {
      observedPids: pidSummary.pids,
      mainBotStarts: pidSummary.starts.length,
      lockHandoffs: pidSummary.handoffs.length,
      alreadyRunningChecks: pidSummary.alreadyRunning.length,
      blockingEvents: blockingEvents.length,
      runtimePid: normalizeNumber(runtimeState.pid, 0),
      runtimeStartedAt: normalizeText(runtimeState.startedAt),
      runtimeHeartbeatAt: normalizeText(runtimeState.heartbeatAt),
      restartCount: normalizeNumber(restartState.count, 0),
      restartLastReason: normalizeText(restartState.lastReason),
      restartCooldownUntil: normalizeText(restartState.cooldownUntil)
    },
    events
  };
}

function buildMainBotStabilityWindowText(report = {}) {
  const summary = report.summary || {};
  const lines = [
    `main-bot-stability-window: ${report.status || 'unknown'}`,
    `window: ${report.window?.start || '-'} -> ${report.window?.end || '-'} expectedPid=${report.expectedPid || 0}`,
    `daemon: starts=${summary.mainBotStarts || 0} handoffs=${summary.lockHandoffs || 0} alreadyRunning=${summary.alreadyRunningChecks || 0} blocking=${summary.blockingEvents || 0} pids=${(summary.observedPids || []).join(',') || '-'}`,
    `runtime-state: pid=${summary.runtimePid || 0} started=${summary.runtimeStartedAt || '-'} heartbeat=${summary.runtimeHeartbeatAt || '-'}`,
    `restart-state: count=${summary.restartCount || 0} reason=${summary.restartLastReason || '-'} cooldown=${summary.restartCooldownUntil || '-'}`
  ];
  if (Array.isArray(report.failures) && report.failures.length > 0) {
    lines.push(`failures: ${report.failures.join(', ')}`);
  }
  lines.push('events:');
  for (const event of Array.isArray(report.events) ? report.events : []) {
    lines.push(`- ${event.at || '-'} ${event.type}${event.pid ? ` pid=${event.pid}` : ''}: ${event.message}`);
  }
  return lines.join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_START,
  DEFAULT_END,
  DEFAULT_EXPECTED_PID,
  buildMainBotStabilityWindowReport,
  buildMainBotStabilityWindowText,
  classifyWindowDaemonMessage,
  parseDaemonTimestamp
};

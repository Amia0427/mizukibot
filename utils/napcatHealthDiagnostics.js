const fs = require('fs');
const path = require('path');
const config = require('../config');

const SCHEMA_VERSION = 'napcat_health_v1';
const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_MAX_LINES = 5000;

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

function isoFromMs(value) {
  const ms = normalizeNumber(value, 0);
  return ms > 0 ? new Date(ms).toISOString() : '';
}

function resolveStateFile(options = {}) {
  return normalizePath(
    options.stateFile
    || process.env.NAPCAT_HEALTH_STATE_FILE
    || path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'napcat-health-state.json')
  );
}

function resolveEventFile(options = {}) {
  return normalizePath(
    options.eventFile
    || process.env.NAPCAT_HEALTH_EVENT_FILE
    || path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'napcat-health-events.ndjson')
  );
}

function safeReadJson(filePath = '') {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function safeStat(filePath = '') {
  try {
    return fs.statSync(filePath);
  } catch (_) {
    return null;
  }
}

function safeWriteJson(filePath = '', value = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeAppendJsonLine(filePath = '', value = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function readRecentJsonLines(filePath = '', maxLines = DEFAULT_MAX_LINES) {
  const target = normalizePath(filePath);
  if (!target) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (_) {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => normalizeText(line))
    .slice(-Math.max(1, Math.floor(normalizeNumber(maxLines, DEFAULT_MAX_LINES))))
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function compactConnectionState(connectionState = {}) {
  if (!connectionState || typeof connectionState !== 'object') return {};
  const connectedSince = normalizeNumber(connectionState.connectedSince, 0);
  const lastConnectedAt = normalizeNumber(connectionState.lastConnectedAt, 0);
  const lastDisconnectedAt = normalizeNumber(connectionState.lastDisconnectedAt, 0);
  return {
    connected: connectionState.connected === true,
    readyState: connectionState.readyState ?? null,
    readyStateName: normalizeText(connectionState.readyStateName),
    pendingCount: connectionState.pendingCount ?? null,
    connectedSince,
    connectedSinceIso: isoFromMs(connectedSince),
    lastConnectedAt,
    lastConnectedAtIso: isoFromMs(lastConnectedAt),
    lastDisconnectedAt,
    lastDisconnectedAtIso: isoFromMs(lastDisconnectedAt),
    lastDisconnectReason: normalizeText(connectionState.lastDisconnectReason),
    disconnectCount: Math.max(0, Math.floor(normalizeNumber(connectionState.disconnectCount, 0))),
    offlineMs: Math.max(0, Math.floor(normalizeNumber(connectionState.offlineMs, 0)))
  };
}

function summarizeDegradationCounts(events = []) {
  const counts = {};
  for (const event of events) {
    if (normalizeText(event?.type) !== 'degradation') continue;
    const action = normalizeText(event.action) || 'unknown';
    counts[action] = (counts[action] || 0) + 1;
  }
  return counts;
}

function rebuildStateFromEvents(events = [], now = Date.now(), previousState = {}) {
  const sorted = events
    .filter((event) => event && typeof event === 'object')
    .slice()
    .sort((a, b) => normalizeNumber(a.ts, 0) - normalizeNumber(b.ts, 0));

  const state = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: normalizeNumber(previousState.updatedAt, 0),
    updatedAtIso: isoFromMs(previousState.updatedAt),
    source: normalizeText(previousState.source),
    connection: previousState.connection && typeof previousState.connection === 'object'
      ? { ...previousState.connection }
      : {
          mode: 'unknown',
          connected: false,
          status: 'unknown',
          offlineSince: 0,
          offlineSinceIso: '',
          offlineMs: 0,
          lastConnectedAt: 0,
          lastConnectedAtIso: '',
          lastDisconnectedAt: 0,
          lastDisconnectedAtIso: '',
          lastRecoveredAt: 0,
          lastRecoveredAtIso: '',
          lastDisconnectReason: '',
          disconnectCount: 0,
          readyStateName: ''
        },
    recentDegradations: Array.isArray(previousState.recentDegradations) ? previousState.recentDegradations.slice(-20) : [],
    degradationCounts: previousState.degradationCounts && typeof previousState.degradationCounts === 'object'
      ? { ...previousState.degradationCounts }
      : {}
  };

  for (const event of sorted) {
    const ts = normalizeNumber(event.ts, 0);
    if (ts <= 0) continue;
    state.updatedAt = Math.max(state.updatedAt || 0, ts);
    state.updatedAtIso = isoFromMs(state.updatedAt);
    state.source = normalizeText(event.source) || state.source;

    if (event.type === 'connection') {
      const status = normalizeText(event.status);
      const snapshot = event.connectionState && typeof event.connectionState === 'object'
        ? event.connectionState
        : {};
      const connected = status === 'online' || snapshot.connected === true;
      const previousOfflineSince = normalizeNumber(state.connection.offlineSince, 0);
      const lastDisconnectedAt = normalizeNumber(snapshot.lastDisconnectedAt, 0) || (connected ? normalizeNumber(state.connection.lastDisconnectedAt, 0) : ts);
      const lastConnectedAt = normalizeNumber(snapshot.lastConnectedAt, 0) || (connected ? ts : normalizeNumber(state.connection.lastConnectedAt, 0));

      state.connection = {
        ...state.connection,
        mode: normalizeText(event.mode) || state.connection.mode || 'websocket',
        connected,
        status: connected ? 'online' : 'offline',
        readyStateName: normalizeText(snapshot.readyStateName) || state.connection.readyStateName,
        offlineSince: connected ? 0 : (previousOfflineSince || lastDisconnectedAt || ts),
        offlineSinceIso: connected ? '' : isoFromMs(previousOfflineSince || lastDisconnectedAt || ts),
        offlineMs: connected ? 0 : Math.max(0, now - (previousOfflineSince || lastDisconnectedAt || ts)),
        lastConnectedAt,
        lastConnectedAtIso: isoFromMs(lastConnectedAt),
        lastDisconnectedAt,
        lastDisconnectedAtIso: isoFromMs(lastDisconnectedAt),
        lastRecoveredAt: connected ? ts : normalizeNumber(state.connection.lastRecoveredAt, 0),
        lastRecoveredAtIso: connected ? isoFromMs(ts) : normalizeText(state.connection.lastRecoveredAtIso),
        lastDisconnectReason: connected ? '' : (normalizeText(event.reason) || normalizeText(snapshot.lastDisconnectReason) || state.connection.lastDisconnectReason),
        disconnectCount: Math.max(
          normalizeNumber(state.connection.disconnectCount, 0),
          normalizeNumber(snapshot.disconnectCount, 0)
        )
      };
    } else if (event.type === 'degradation') {
      const compact = compactDegradationEvent(event);
      state.recentDegradations.push(compact);
      state.recentDegradations = state.recentDegradations.slice(-20);
      const action = compact.action || 'unknown';
      state.degradationCounts[action] = (state.degradationCounts[action] || 0) + 1;
      const snapshot = event.connectionState && typeof event.connectionState === 'object'
        ? event.connectionState
        : {};
      if (snapshot.connected === false && state.connection.connected !== true) {
        const offlineSince = normalizeNumber(state.connection.offlineSince, 0)
          || normalizeNumber(snapshot.lastDisconnectedAt, 0)
          || ts;
        state.connection = {
          ...state.connection,
          connected: false,
          status: 'offline',
          readyStateName: normalizeText(snapshot.readyStateName) || state.connection.readyStateName,
          offlineSince,
          offlineSinceIso: isoFromMs(offlineSince),
          offlineMs: Math.max(0, now - offlineSince),
          lastDisconnectedAt: normalizeNumber(snapshot.lastDisconnectedAt, 0) || normalizeNumber(state.connection.lastDisconnectedAt, 0) || offlineSince,
          lastDisconnectedAtIso: isoFromMs(normalizeNumber(snapshot.lastDisconnectedAt, 0) || normalizeNumber(state.connection.lastDisconnectedAt, 0) || offlineSince),
          lastDisconnectReason: normalizeText(snapshot.lastDisconnectReason) || state.connection.lastDisconnectReason || compact.reason
        };
      }
    }
  }

  if (state.connection.connected !== true && state.connection.offlineSince) {
    state.connection.offlineMs = Math.max(0, now - normalizeNumber(state.connection.offlineSince, now));
  }

  return state;
}

function compactDegradationEvent(event = {}) {
  const ts = normalizeNumber(event.ts, 0);
  const connectionState = compactConnectionState(event.connectionState || {});
  return {
    ts,
    at: normalizeText(event.at) || isoFromMs(ts),
    action: normalizeText(event.action) || 'unknown',
    reason: normalizeText(event.reason) || 'unknown',
    module: normalizeText(event.module),
    messageId: normalizeText(event.messageId),
    groupId: normalizeText(event.groupId),
    userId: normalizeText(event.userId),
    routePolicyKey: normalizeText(event.routePolicyKey),
    connectionStatus: connectionState.connected ? 'online' : 'offline',
    offlineMs: connectionState.offlineMs || 0
  };
}

function recordNapCatHealthEvent(input = {}, options = {}) {
  const ts = normalizeNumber(input.ts, 0) || nowMs(options);
  const event = {
    schemaVersion: SCHEMA_VERSION,
    ts,
    at: isoFromMs(ts),
    type: normalizeText(input.type),
    source: normalizeText(input.source) || 'mizukibot',
    mode: normalizeText(input.mode),
    status: normalizeText(input.status),
    action: normalizeText(input.action),
    reason: normalizeText(input.reason),
    module: normalizeText(input.module),
    messageId: normalizeText(input.messageId),
    groupId: normalizeText(input.groupId),
    userId: normalizeText(input.userId),
    routePolicyKey: normalizeText(input.routePolicyKey),
    connectionState: compactConnectionState(input.connectionState || {})
  };

  try {
    const stateFile = resolveStateFile(options);
    const eventFile = resolveEventFile(options);
    safeAppendJsonLine(eventFile, event);
    const previousState = safeReadJson(stateFile) || {};
    const state = rebuildStateFromEvents([event], nowMs(options), previousState);
    safeWriteJson(stateFile, state);
    return { ok: true, event, state };
  } catch (error) {
    return {
      ok: false,
      event,
      error: normalizeText(error?.message || error)
    };
  }
}

function recordNapCatConnectionState(status = '', connectionState = {}, options = {}) {
  const normalizedStatus = normalizeText(status);
  return recordNapCatHealthEvent({
    type: 'connection',
    status: normalizedStatus,
    mode: options.mode || 'websocket',
    reason: options.reason,
    source: options.source,
    connectionState
  }, options);
}

function recordNapCatDegradation(action = '', details = {}, options = {}) {
  return recordNapCatHealthEvent({
    type: 'degradation',
    status: 'degraded',
    action,
    reason: details.reason || 'napcat_offline',
    module: details.module,
    messageId: details.messageId,
    groupId: details.groupId,
    userId: details.userId,
    routePolicyKey: details.routePolicyKey,
    source: details.source,
    mode: details.mode,
    connectionState: details.connectionState
  }, options);
}

function buildInputs(options = {}, eventRows = []) {
  const stateFile = resolveStateFile(options);
  const eventFile = resolveEventFile(options);
  return {
    stateFile: {
      path: stateFile,
      exists: Boolean(safeStat(stateFile))
    },
    eventFile: {
      path: eventFile,
      exists: Boolean(safeStat(eventFile)),
      rows: eventRows.length
    }
  };
}

function buildNapCatHealthDiagnostic(options = {}) {
  const now = nowMs(options);
  const maxEvents = Math.max(1, Math.floor(normalizeNumber(options.maxEvents, DEFAULT_MAX_EVENTS)));
  const stateFile = resolveStateFile(options);
  const state = options.state && typeof options.state === 'object'
    ? options.state
    : (safeReadJson(stateFile) || null);
  const eventRows = Array.isArray(options.events)
    ? options.events
    : readRecentJsonLines(resolveEventFile(options), Math.max(maxEvents, normalizeNumber(options.maxLines, DEFAULT_MAX_LINES)));
  const recentEvents = eventRows
    .filter((event) => normalizeText(event.schemaVersion) === SCHEMA_VERSION || normalizeText(event.type))
    .slice(-maxEvents);
  const rebuilt = state
    ? rebuildStateFromEvents([], now, state)
    : rebuildStateFromEvents(recentEvents, now, {});
  const connection = rebuilt.connection || {};
  const recentDegradations = recentEvents
    .filter((event) => normalizeText(event.type) === 'degradation')
    .map(compactDegradationEvent)
    .reverse()
    .slice(0, maxEvents);
  const degradationCounts = summarizeDegradationCounts(recentEvents);
  const connected = connection.connected === true;
  const status = connected ? 'online' : (connection.status || 'unknown');

  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: isoFromMs(now),
    summary: {
      status,
      connected,
      offline: connected ? false : status === 'offline',
      offlineSince: normalizeText(connection.offlineSinceIso),
      offlineMs: connected ? 0 : Math.max(0, normalizeNumber(connection.offlineMs, 0)),
      lastConnectedAt: normalizeText(connection.lastConnectedAtIso),
      lastDisconnectedAt: normalizeText(connection.lastDisconnectedAtIso),
      lastRecoveredAt: normalizeText(connection.lastRecoveredAtIso),
      lastDisconnectReason: normalizeText(connection.lastDisconnectReason),
      recentDegradationCount: recentDegradations.length,
      recentDegradationActions: Object.entries(degradationCounts)
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
      lastDegradationAt: recentDegradations[0]?.at || ''
    },
    connection,
    recentDegradations,
    events: recentEvents.slice().reverse(),
    inputs: buildInputs(options, recentEvents)
  };
}

function formatDuration(ms = 0) {
  const totalMs = Math.max(0, Math.floor(normalizeNumber(ms, 0)));
  if (totalMs < 1000) return `${totalMs}ms`;
  const totalSeconds = Math.floor(totalMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function buildNapCatHealthText(report = {}) {
  const summary = report.summary || {};
  const lines = [
    `napcat-health: ${summary.status || 'unknown'} offline=${summary.offline === true ? 'yes' : 'no'} offlineDuration=${formatDuration(summary.offlineMs || 0)}`,
    `last-disconnected: ${summary.lastDisconnectedAt || 'none'} reason=${summary.lastDisconnectReason || 'none'}`,
    `last-recovered: ${summary.lastRecoveredAt || summary.lastConnectedAt || 'none'}`,
    `recent-degradations: ${summary.recentDegradationCount || 0}`
  ];
  const actions = Array.isArray(summary.recentDegradationActions) ? summary.recentDegradationActions : [];
  if (actions.length > 0) {
    lines.push(`degradation-actions: ${actions.map((item) => `${item.key}:${item.count}`).join(', ')}`);
  }
  const recent = Array.isArray(report.recentDegradations) ? report.recentDegradations.slice(0, 8) : [];
  if (recent.length > 0) {
    lines.push('latest:');
    for (const event of recent) {
      lines.push(`- ${event.at || 'unknown'} ${event.action || 'unknown'} reason=${event.reason || 'unknown'} offlineMs=${formatDuration(event.offlineMs || 0)}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_MAX_EVENTS,
  SCHEMA_VERSION,
  buildNapCatHealthDiagnostic,
  buildNapCatHealthText,
  compactConnectionState,
  recordNapCatConnectionState,
  recordNapCatDegradation,
  recordNapCatHealthEvent,
  rebuildStateFromEvents,
  resolveEventFile,
  resolveStateFile
};

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DEFAULT_MAX_LINES = 50000;
const DEFAULT_LIMIT = 20;
const DEFAULT_AROUND_WINDOW_MS = 10 * 60 * 1000;
const MAIN_REPLY_SOURCES = new Set([
  'v2_streaming_reply',
  'direct_reply',
  'normal_fast_reply',
  'draft_reply'
]);
const HTTP_TRACE_PHASES = new Set([
  'http_client_start',
  'http_client_failure',
  'http_client_success'
]);

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  const text = normalizeText(value).toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

function readArgValue(argv, index) {
  const item = String(argv[index] || '');
  const eq = item.indexOf('=');
  if (eq >= 0) return { value: item.slice(eq + 1), consumed: 0 };
  return { value: argv[index + 1], consumed: 1 };
}

function parseDurationMs(value = '') {
  const text = normalizeText(value).toLowerCase();
  if (!text) return 0;
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = match[2] || 'm';
  if (unit === 'ms') return Math.round(amount);
  if (unit === 's') return Math.round(amount * 1000);
  if (unit === 'h') return Math.round(amount * 60 * 60 * 1000);
  if (unit === 'd') return Math.round(amount * 24 * 60 * 60 * 1000);
  return Math.round(amount * 60 * 1000);
}

function parseTimestampMs(value = '') {
  const text = normalizeText(value);
  if (!text) return 0;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : 0;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dataDir: DEFAULT_DATA_DIR,
    modelCallsFile: '',
    requestTraceFile: '',
    maxLines: DEFAULT_MAX_LINES,
    limit: DEFAULT_LIMIT,
    sinceMs: 0,
    aroundMs: 0,
    aroundWindowMs: 0,
    adminOnly: false,
    json: false,
    text: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = normalizeText(argv[i]);
    const key = item.split('=')[0];
    if (key === '--help' || key === '-h') {
      options.help = true;
    } else if (key === '--data-dir') {
      const { value, consumed } = readArgValue(argv, i);
      options.dataDir = path.resolve(String(value || ''));
      i += consumed;
    } else if (key === '--model-calls') {
      const { value, consumed } = readArgValue(argv, i);
      options.modelCallsFile = path.resolve(String(value || ''));
      i += consumed;
    } else if (key === '--request-trace') {
      const { value, consumed } = readArgValue(argv, i);
      options.requestTraceFile = path.resolve(String(value || ''));
      i += consumed;
    } else if (key === '--max-lines') {
      const { value, consumed } = readArgValue(argv, i);
      options.maxLines = Math.max(100, Math.floor(normalizeNumber(value, DEFAULT_MAX_LINES)));
      i += consumed;
    } else if (key === '--limit') {
      const { value, consumed } = readArgValue(argv, i);
      options.limit = Math.max(1, Math.floor(normalizeNumber(value, DEFAULT_LIMIT)));
      i += consumed;
    } else if (key === '--since') {
      const { value, consumed } = readArgValue(argv, i);
      options.sinceMs = parseDurationMs(value);
      i += consumed;
    } else if (key === '--around') {
      const { value, consumed } = readArgValue(argv, i);
      options.aroundMs = parseTimestampMs(value);
      i += consumed;
    } else if (key === '--window') {
      const { value, consumed } = readArgValue(argv, i);
      options.aroundWindowMs = parseDurationMs(value);
      i += consumed;
    } else if (key === '--admin-only') {
      options.adminOnly = true;
    } else if (key === '--json') {
      options.json = true;
    } else if (key === '--text') {
      options.text = true;
    }
  }

  if (options.aroundMs > 0 && options.aroundWindowMs <= 0) {
    options.aroundWindowMs = DEFAULT_AROUND_WINDOW_MS;
  }
  if (!options.json && !options.text) options.text = true;
  return options;
}

function resolveInputFiles(options = {}) {
  const dataDir = path.resolve(options.dataDir || DEFAULT_DATA_DIR);
  return {
    dataDir,
    modelCallsFile: path.resolve(options.modelCallsFile || path.join(dataDir, 'model-calls.ndjson')),
    requestTraceFile: path.resolve(options.requestTraceFile || path.join(dataDir, 'request-trace.ndjson'))
  };
}

function parseJsonLine(line = '') {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function readRecentJsonLines(filePath = '', maxLines = DEFAULT_MAX_LINES) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => normalizeText(line))
    .slice(-Math.max(1, Math.floor(normalizeNumber(maxLines, DEFAULT_MAX_LINES))))
    .map(parseJsonLine)
    .filter(Boolean);
}

function rowTimeMs(row = {}) {
  for (const key of ['recordedAt', 'ts', 'completed_at', 'started_at', 'createdAt', 'updatedAt']) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  const started = Number(row.requestStartedAt || 0);
  const elapsed = Number(row.elapsedSinceRequestStartMs || 0);
  if (Number.isFinite(started) && started > 0) {
    return started + (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0);
  }
  return 0;
}

function filterRowsByWindow(rows = [], options = {}) {
  const untilMs = normalizeNumber(options.nowMs, Date.now());
  const sinceMs = Number(options.sinceMs || 0) > 0 ? untilMs - Number(options.sinceMs) : 0;
  const aroundMs = normalizeNumber(options.aroundMs, 0);
  const aroundWindowMs = normalizeNumber(options.aroundWindowMs, 0);
  return rows.filter((row) => {
    const ms = rowTimeMs(row);
    if (sinceMs > 0 && ms > 0 && ms < sinceMs) return false;
    if (aroundMs > 0 && aroundWindowMs > 0) {
      return ms > 0 && Math.abs(ms - aroundMs) <= aroundWindowMs;
    }
    return true;
  });
}

function requestIdOf(row = {}) {
  return normalizeText(row.requestId || row.request_id);
}

function routePolicyKeyOf(row = {}) {
  return normalizeText(row.routePolicyKey || row.route_policy_key || row.modelRouteDiagnostic?.routePolicyKey || row.model_route_diagnostic?.routePolicyKey);
}

function routeDebugKeyOf(row = {}) {
  return normalizeText(row.routeDebugKey || row.route_debug_key || row.modelRouteDiagnostic?.routeDebugKey || row.model_route_diagnostic?.routeDebugKey);
}

function topRouteTypeOf(row = {}) {
  return normalizeText(row.topRouteType || row.top_route_type || row.modelRouteDiagnostic?.topRouteType || row.model_route_diagnostic?.topRouteType);
}

function dispatchBranchOf(row = {}) {
  return normalizeText(row.dispatchBranch || row.dispatch_branch || row.modelRouteDiagnostic?.branch || row.model_route_diagnostic?.branch);
}

function triggerBranchOf(row = {}) {
  return normalizeText(row.triggerBranch || row.trigger_branch || row.modelRouteDiagnostic?.triggerBranch || row.model_route_diagnostic?.triggerBranch);
}

function providerOf(row = {}) {
  return normalizeText(row.provider || row.modelRouteDiagnostic?.provider || row.model_route_diagnostic?.provider);
}

function modelOf(row = {}) {
  return normalizeText(row.model || row.modelRouteDiagnostic?.model || row.model_route_diagnostic?.model);
}

function hostFromUrl(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  try {
    return new URL(text).host;
  } catch (_) {
    return '';
  }
}

function hostOf(row = {}) {
  return normalizeText(row.apiBaseUrlHost || row.api_base_url_host || row.host)
    || hostFromUrl(row.requestUrl || row.apiBaseUrl || row.api_base_url || row.modelRouteDiagnostic?.apiBaseUrl || row.model_route_diagnostic?.apiBaseUrl);
}

function sourceOf(row = {}) {
  return normalizeText(row.source);
}

function attemptOf(row = {}) {
  const n = normalizeNumber(row.attempt ?? row.attempts, 0);
  return n > 0 ? Math.floor(n) : null;
}

function statusCodeOf(row = {}) {
  const statusCode = normalizeNumber(row.statusCode ?? row.status_code, 0);
  return statusCode > 0 ? statusCode : null;
}

function finalErrorCodeOf(row = {}) {
  return normalizeText(row.finalErrorCode || row.final_error_code).toLowerCase();
}

function is408Failure(row = {}) {
  if (statusCodeOf(row) === 408) return true;
  if (finalErrorCodeOf(row) === 'http_408') return true;
  return /status code 408|http_408/i.test(normalizeText(row.error));
}

function isMainReplySource(source = '') {
  return MAIN_REPLY_SOURCES.has(normalizeText(source));
}

function tracePhaseOf(row = {}) {
  return normalizeText(row.tracePhase || row.stage);
}

function isMainModelTraceEvent(row = {}) {
  const phase = tracePhaseOf(row);
  return HTTP_TRACE_PHASES.has(phase) && isMainReplySource(sourceOf(row)) && Boolean(requestIdOf(row));
}

function isMainModelCall(row = {}) {
  return isMainReplySource(sourceOf(row)) && Boolean(requestIdOf(row));
}

function callGroupKey(row = {}) {
  return [
    requestIdOf(row),
    sourceOf(row),
    providerOf(row),
    hostOf(row),
    modelOf(row),
    routePolicyKeyOf(row),
    routeDebugKeyOf(row),
    triggerBranchOf(row)
  ].join('|');
}

function sortByTimeThenAttempt(rows = []) {
  return rows.slice().sort((a, b) => {
    const attemptA = attemptOf(a) || 0;
    const attemptB = attemptOf(b) || 0;
    if (attemptA || attemptB) return attemptA - attemptB;
    return rowTimeMs(a) - rowTimeMs(b);
  });
}

function groupRows(rows = [], predicate = () => true) {
  const grouped = new Map();
  for (const row of rows) {
    if (!predicate(row)) continue;
    const key = callGroupKey(row);
    if (!requestIdOf(row) || !key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

function hasLaterRow(anchor = {}, rows = []) {
  const anchorAttempt = attemptOf(anchor) || 0;
  const anchorMs = rowTimeMs(anchor);
  return rows.some((row) => {
    const attempt = attemptOf(row) || 0;
    if (anchorAttempt > 0 && attempt > anchorAttempt) return true;
    const ms = rowTimeMs(row);
    return anchorMs > 0 && ms > anchorMs;
  });
}

function pickFirstMetadata(rows = []) {
  return rows.find((row) => providerOf(row) || modelOf(row) || routePolicyKeyOf(row)) || rows[0] || {};
}

function summarizeHttpTimeline(rows = []) {
  return sortByTimeThenAttempt(rows)
    .filter((row) => HTTP_TRACE_PHASES.has(tracePhaseOf(row)))
    .map((row) => ({
      at: new Date(rowTimeMs(row)).toISOString(),
      source: 'request-trace',
      phase: tracePhaseOf(row),
      attempt: attemptOf(row),
      statusCode: statusCodeOf(row),
      retryable: normalizeBoolean(row.retryable),
      durationMs: normalizeNumber(row.durationMs ?? row.duration_ms, null),
      errorCode: finalErrorCodeOf(row)
    }));
}

function summarizeModelTimeline(rows = []) {
  return sortByTimeThenAttempt(rows).map((row) => ({
    at: new Date(rowTimeMs(row)).toISOString(),
    source: 'model-calls',
    id: normalizeText(row.id),
    status: normalizeText(row.status),
    attempt: attemptOf(row),
    statusCode: statusCodeOf(row),
    durationMs: normalizeNumber(row.duration_ms ?? row.durationMs, null),
    errorCode: finalErrorCodeOf(row)
  }));
}

function summarizeTraceGroup(rows = []) {
  const events = sortByTimeThenAttempt(rows);
  const starts = events.filter((row) => tracePhaseOf(row) === 'http_client_start');
  const failures408 = events.filter((row) => tracePhaseOf(row) === 'http_client_failure' && is408Failure(row));
  const successes = events.filter((row) => tracePhaseOf(row) === 'http_client_success');
  const retryable408Failures = failures408.filter((row) => normalizeBoolean(row.retryable) === true);
  const retriedAfter408 = failures408.some((row) => hasLaterRow(row, starts));
  if (failures408.length === 0 || starts.length < 2 || (!retriedAfter408 && retryable408Failures.length === 0)) return null;

  const meta = pickFirstMetadata(events);
  return {
    requestId: requestIdOf(meta),
    key: callGroupKey(meta),
    source: sourceOf(meta),
    provider: providerOf(meta),
    host: hostOf(meta),
    model: modelOf(meta),
    userId: normalizeText(meta.userId || meta.user_id),
    userRole: normalizeText(meta.userRole || meta.user_role),
    isAdmin: events.some((row) => row.isAdmin === true || normalizeText(row.userRole || row.user_role) === 'admin'),
    chatType: normalizeText(meta.chatType || meta.chat_type),
    routePolicyKey: routePolicyKeyOf(meta),
    routeDebugKey: routeDebugKeyOf(meta),
    topRouteType: topRouteTypeOf(meta),
    dispatchBranch: dispatchBranchOf(meta),
    triggerBranch: triggerBranchOf(meta),
    trace: {
      httpStarts: starts.length,
      httpSuccesses: successes.length,
      failures408: failures408.length,
      retryable408Failures: retryable408Failures.length,
      retriedAfter408,
      maxAttempt: Math.max(0, ...events.map((row) => attemptOf(row) || 0)),
      first408At: new Date(Math.min(...failures408.map(rowTimeMs).filter((ms) => ms > 0))).toISOString(),
      timeline: summarizeHttpTimeline(events)
    }
  };
}

function summarizeModelGroup(rows = []) {
  const calls = sortByTimeThenAttempt(rows);
  const failures408 = calls.filter((row) => normalizeText(row.status) === 'failed' && is408Failure(row));
  const successes = calls.filter((row) => normalizeText(row.status) === 'succeeded');
  const maxAttempt = Math.max(0, ...calls.map((row) => attemptOf(row) || 0));
  const successAfter408 = failures408.some((row) => hasLaterRow(row, successes));
  if (failures408.length === 0 || (calls.length < 2 && maxAttempt <= 1 && !successAfter408)) return null;

  const meta = pickFirstMetadata(calls);
  return {
    requestId: requestIdOf(meta),
    key: callGroupKey(meta),
    source: sourceOf(meta),
    provider: providerOf(meta),
    host: hostOf(meta),
    model: modelOf(meta),
    userId: normalizeText(meta.user_id || meta.userId),
    userRole: normalizeText(meta.user_role || meta.userRole),
    isAdmin: calls.some((row) => normalizeText(row.user_role || row.userRole) === 'admin'),
    chatType: normalizeText(meta.chat_type || meta.chatType),
    routePolicyKey: routePolicyKeyOf(meta),
    routeDebugKey: routeDebugKeyOf(meta),
    topRouteType: topRouteTypeOf(meta),
    dispatchBranch: dispatchBranchOf(meta),
    triggerBranch: triggerBranchOf(meta),
    modelCalls: {
      rows: calls.length,
      failures408: failures408.length,
      successes: successes.length,
      successAfter408,
      maxAttempt,
      first408At: new Date(Math.min(...failures408.map(rowTimeMs).filter((ms) => ms > 0))).toISOString(),
      timeline: summarizeModelTimeline(calls)
    }
  };
}

function mergeIncident(existing = null, next = {}) {
  if (!existing) return next;
  return {
    ...existing,
    ...Object.fromEntries(
      Object.entries(next).filter(([_, value]) => value !== '' && value !== null && value !== undefined)
    ),
    isAdmin: existing.isAdmin === true || next.isAdmin === true,
    trace: existing.trace || next.trace,
    modelCalls: existing.modelCalls || next.modelCalls
  };
}

function firstIncidentMs(incident = {}) {
  const candidates = [
    parseTimestampMs(incident.trace?.first408At),
    parseTimestampMs(incident.modelCalls?.first408At),
    ...(incident.trace?.timeline || []).map((row) => parseTimestampMs(row.at)),
    ...(incident.modelCalls?.timeline || []).map((row) => parseTimestampMs(row.at))
  ].filter((ms) => ms > 0);
  return candidates.length > 0 ? Math.min(...candidates) : 0;
}

function latestIncidentMs(incident = {}) {
  const candidates = [
    ...(incident.trace?.timeline || []).map((row) => parseTimestampMs(row.at)),
    ...(incident.modelCalls?.timeline || []).map((row) => parseTimestampMs(row.at))
  ].filter((ms) => ms > 0);
  return candidates.length > 0 ? Math.max(...candidates) : firstIncidentMs(incident);
}

function countDistinct408Attempts(incidents = []) {
  let count = 0;
  for (const incident of incidents) {
    const seen = new Set();
    const rows = [
      ...(incident.trace?.timeline || []),
      ...(incident.modelCalls?.timeline || [])
    ];
    for (const row of rows) {
      if (row.statusCode !== 408 && normalizeText(row.errorCode) !== 'http_408') continue;
      const attempt = normalizeNumber(row.attempt, 0);
      const key = attempt > 0 ? `attempt:${attempt}` : `time:${parseTimestampMs(row.at) || row.at}`;
      seen.add(key);
    }
    count += seen.size;
  }
  return count;
}

function buildMainModelRetryDuplicateDiagnostic(options = {}) {
  const files = resolveInputFiles(options);
  const maxLines = Math.max(100, Math.floor(normalizeNumber(options.maxLines, DEFAULT_MAX_LINES)));
  const traceRows = filterRowsByWindow(
    Array.isArray(options.traceRows) ? options.traceRows : readRecentJsonLines(files.requestTraceFile, maxLines),
    options
  );
  const modelRows = filterRowsByWindow(
    Array.isArray(options.modelRows) ? options.modelRows : readRecentJsonLines(files.modelCallsFile, maxLines),
    options
  );

  const incidentsByKey = new Map();
  for (const rows of groupRows(traceRows, isMainModelTraceEvent).values()) {
    const incident = summarizeTraceGroup(rows);
    if (!incident) continue;
    incidentsByKey.set(incident.key, mergeIncident(incidentsByKey.get(incident.key), incident));
  }
  for (const rows of groupRows(modelRows, isMainModelCall).values()) {
    const incident = summarizeModelGroup(rows);
    if (!incident) continue;
    incidentsByKey.set(incident.key, mergeIncident(incidentsByKey.get(incident.key), incident));
  }

  const allIncidents = Array.from(incidentsByKey.values())
    .filter((incident) => options.adminOnly !== true || incident.isAdmin === true || normalizeText(incident.userRole) === 'admin')
    .sort((a, b) => latestIncidentMs(b) - latestIncidentMs(a));
  const limit = Math.max(1, Math.floor(normalizeNumber(options.limit, DEFAULT_LIMIT)));
  const incidents = allIncidents.slice(0, limit);
  const requestIds = new Set(allIncidents.map((incident) => incident.requestId).filter(Boolean));

  return {
    schemaVersion: 'main_model_retry_duplicate_diagnostic_v1',
    generatedAt: new Date().toISOString(),
    files,
    inputs: {
      maxLines,
      limit,
      sinceMs: Math.max(0, normalizeNumber(options.sinceMs, 0)),
      aroundMs: Math.max(0, normalizeNumber(options.aroundMs, 0)),
      aroundWindowMs: Math.max(0, normalizeNumber(options.aroundWindowMs, 0)),
      adminOnly: options.adminOnly === true,
      rows: {
        requestTrace: traceRows.length,
        modelCalls: modelRows.length
      }
    },
    summary: {
      clean: allIncidents.length === 0,
      suspiciousRequests: requestIds.size,
      suspiciousCallGroups: allIncidents.length,
      returnedSamples: incidents.length,
      adminRequestHits: allIncidents.filter((incident) => incident.isAdmin === true || normalizeText(incident.userRole) === 'admin').length,
      distinct408Attempts: countDistinct408Attempts(allIncidents)
    },
    incidents
  };
}

function formatMs(value) {
  if (value === null || value === undefined || value === '') return 'n/a';
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}ms` : 'n/a';
}

function formatAttemptList(timeline = []) {
  const attempts = timeline
    .map((item) => item.attempt)
    .filter((item) => Number.isFinite(Number(item)));
  return attempts.length > 0 ? Array.from(new Set(attempts)).join(',') : 'n/a';
}

function formatTimeline(timeline = [], limit = 8) {
  return timeline.slice(0, limit).map((item) => {
    const status = item.status || item.phase || '';
    const statusCode = item.statusCode ? ` status=${item.statusCode}` : '';
    const retryable = item.retryable === null || item.retryable === undefined ? '' : ` retryable=${item.retryable}`;
    const duration = item.durationMs === null || item.durationMs === undefined ? '' : ` duration=${formatMs(item.durationMs)}`;
    return `${item.at} ${item.source} attempt=${item.attempt || 'n/a'} ${status}${statusCode}${retryable}${duration}`.trim();
  });
}

function formatMainModelRetryDuplicateDiagnostic(report = {}) {
  const summary = report.summary || {};
  const lines = [
    `主模型408重试重复调用诊断: suspiciousRequests=${summary.suspiciousRequests || 0} callGroups=${summary.suspiciousCallGroups || 0} returned=${summary.returnedSamples || 0}`,
    summary.clean === true
      ? '结论: 未发现“同一请求因408/重试导致的疑似重复主模型调用”。'
      : '结论: 命中疑似重复主模型调用；同一 requestId 在 408 retryable 后继续发起主模型请求，可能把上游仍在生成的调用放大为多次主模型调用。',
    `modelCalls=${report.files?.modelCallsFile || ''}`,
    `requestTrace=${report.files?.requestTraceFile || ''}`
  ];

  if (!Array.isArray(report.incidents) || report.incidents.length === 0) {
    return lines.join('\n');
  }

  for (const incident of report.incidents) {
    const trace = incident.trace || {};
    const modelCalls = incident.modelCalls || {};
    const timeline = [
      ...formatTimeline(trace.timeline || []),
      ...formatTimeline(modelCalls.timeline || [])
    ].slice(0, 12);
    lines.push(`- ${incident.requestId} role=${incident.userRole || (incident.isAdmin ? 'admin' : 'unknown')} user=${incident.userId || 'n/a'} route=${incident.routePolicyKey || 'n/a'} model=${incident.provider || 'n/a'}/${incident.model || 'n/a'} host=${incident.host || 'n/a'} source=${incident.source || 'n/a'}`);
    lines.push([
      '  evidence:',
      `traceStarts=${trace.httpStarts || 0}`,
      `trace408=${trace.failures408 || 0}`,
      `retryable408=${trace.retryable408Failures || 0}`,
      `modelCallRows=${modelCalls.rows || 0}`,
      `model408=${modelCalls.failures408 || 0}`,
      `successAfter408=${trace.httpSuccesses > 0 || modelCalls.successAfter408 === true}`,
      `attempts=${formatAttemptList([...(trace.timeline || []), ...(modelCalls.timeline || [])])}`
    ].join(' '));
    for (const item of timeline) {
      lines.push(`  timeline: ${item}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  buildMainModelRetryDuplicateDiagnostic,
  formatMainModelRetryDuplicateDiagnostic,
  is408Failure,
  isMainModelCall,
  isMainModelTraceEvent,
  parseArgs,
  parseDurationMs,
  readRecentJsonLines,
  summarizeModelGroup,
  summarizeTraceGroup
};

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { buildRuntimeStatusDiagnostic } = require('./runtimeStatusDiagnostics');
const {
  filterWindow,
  readRecentJsonLines,
  resolveEventMs,
  safeStat
} = require('./runtimeHotspots/sampleFiles');
const {
  isoFromMs,
  normalizeNumber,
  normalizePath,
  normalizeText,
  nowMs
} = require('./runtimeHotspots/common');

const SCHEMA_VERSION = 'runtime_exception_diagnostic_v1';
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LINES = 5000;

function parseWindowMs(value = '') {
  const text = normalizeText(value).toLowerCase();
  if (!text) return 0;
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = match[2] || 'h';
  if (unit === 'ms') return Math.round(amount);
  if (unit === 's') return Math.round(amount * 1000);
  if (unit === 'm') return Math.round(amount * 60 * 1000);
  if (unit === 'd') return Math.round(amount * 24 * 60 * 60 * 1000);
  return Math.round(amount * 60 * 60 * 1000);
}

function truthy(value) {
  if (value === true) return true;
  const text = normalizeText(value).toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

function normalizeLower(value = '') {
  return normalizeText(value).toLowerCase();
}

function countBy(items = [], keySelector = () => '') {
  const counts = new Map();
  for (const item of items) {
    const key = normalizeText(keySelector(item));
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function mergeCountItems(items = []) {
  const counts = new Map();
  for (const item of items) {
    const key = normalizeText(item?.key);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + Math.max(0, Math.floor(normalizeNumber(item?.count, 0))));
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function resolveRowMs(row = {}) {
  const fromShared = resolveEventMs(row);
  if (fromShared > 0) return fromShared;
  for (const field of ['completed_at', 'completedAt', 'started_at', 'startedAt']) {
    const parsed = Date.parse(String(row?.[field] || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseLogLineMs(line = '', fallbackMs = 0) {
  const text = String(line || '');
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0]);
    if (Number.isFinite(parsed)) return parsed;
  }
  const bracketMatch = text.match(/\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\]/);
  if (bracketMatch) {
    const parsed = Date.parse(`${bracketMatch[1]}T${bracketMatch[2]}`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Math.max(0, normalizeNumber(fallbackMs, 0));
}

function resolveModelCallLogFile(options = {}) {
  return normalizePath(
    options.modelCallLogFile
    || path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'model-calls.ndjson')
  );
}

function resolveMemoryRecallLogFile(options = {}) {
  return normalizePath(
    options.memoryRecallLogFile
    || path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'memory-recall-observability.ndjson')
  );
}

function resolveRuntimeLogFiles(options = {}) {
  if (Array.isArray(options.logFiles)) {
    return options.logFiles.map((item) => normalizePath(item)).filter(Boolean);
  }
  const dataDir = normalizePath(config.DATA_DIR || path.join(process.cwd(), 'data'));
  return [
    'bot-runtime.err.log',
    'bot-runtime.out.log',
    'post-reply-worker.err.log',
    'post-reply-worker.out.log',
    'bot-daemon.log'
  ].map((name) => path.join(dataDir, name));
}

function readRecentTextLogLines(filePath = '', maxLines = DEFAULT_MAX_LINES) {
  const target = normalizePath(filePath);
  if (!target) return [];
  const stat = safeStat(target);
  if (!stat) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (_) {
    return [];
  }
  const fallbackMs = normalizeNumber(stat.mtimeMs, 0);
  return raw
    .split(/\r?\n/)
    .map((line, index) => ({
      filePath: target,
      file: path.basename(target),
      lineNumber: index + 1,
      line,
      ms: parseLogLineMs(line, fallbackMs)
    }))
    .filter((row) => normalizeText(row.line))
    .slice(-Math.max(1, Math.floor(normalizeNumber(maxLines, DEFAULT_MAX_LINES))));
}

function readRuntimeLogLines(options = {}) {
  if (Array.isArray(options.logRows)) return options.logRows;
  const maxLines = Math.max(100, Math.floor(normalizeNumber(options.maxLines, DEFAULT_MAX_LINES)));
  return resolveRuntimeLogFiles(options).flatMap((filePath) => readRecentTextLogLines(filePath, maxLines));
}

function rowMainFallbackScope(row = {}) {
  return normalizeText(
    row.main_fallback_scope
    || row.mainFallbackScope
    || row.model_route_diagnostic?.fallbackScope
    || row.modelRouteDiagnostic?.fallbackScope
  );
}

function rowMainFallbackActive(row = {}) {
  return truthy(
    row.main_fallback_active
    ?? row.mainFallbackActive
    ?? row.model_route_diagnostic?.fallbackActive
    ?? row.modelRouteDiagnostic?.fallbackActive
  );
}

function rowSource(row = {}) {
  return normalizeText(row.source || row.module || row.component || row.stage || 'unknown') || 'unknown';
}

function rowPhase(row = {}) {
  return normalizeText(row.phase || row.stage || row.tracePhase || row.purpose);
}

function rowModuleKey(row = {}) {
  const source = rowSource(row);
  const phase = rowPhase(row);
  return phase && phase !== source ? `${source}/${phase}` : source;
}

function rowErrorText(row = {}) {
  return normalizeLower([
    row.error,
    row.message,
    row.final_error_code,
    row.finalErrorCode,
    row.code,
    row.status
  ].filter((item) => item !== undefined && item !== null).join(' '));
}

function isTimeoutish(row = {}) {
  const text = rowErrorText(row);
  return /timeout|timed out|err_canceled|canceled|cancelled|abort|aborted|econnaborted/.test(text);
}

function isAdminSharedPrimaryFailure(row = {}) {
  return rowMainFallbackScope(row) === 'admin_shared'
    && normalizeLower(row.status) === 'failed'
    && !rowMainFallbackActive(row);
}

function isAdminSharedFallbackActiveCall(row = {}) {
  return rowMainFallbackScope(row) === 'admin_shared' && rowMainFallbackActive(row);
}

function isAdminSharedActivationLog(row = {}) {
  return /\[main-model-fallback:admin_shared\].*activated backup model/i.test(String(row.line || ''));
}

function isMemoryRerankerTimeoutModelCall(row = {}) {
  return normalizeLower(row.source) === 'memoryreranker'
    && normalizeLower(row.status) === 'failed'
    && isTimeoutish(row);
}

function isMemoryRerankerTimeoutLog(row = {}) {
  return /\[memoryReranker\].*(timed out|timeout|canceled|cancelled|aborted).*fallback to base recall/i.test(String(row.line || ''));
}

function extractDroppedReasons(row = {}) {
  const candidates = [
    row.memoryTrace?.dropped_reasons,
    row.memoryTrace?.droppedReasons,
    row.localMemory?.trace?.dropped_reasons,
    row.localMemory?.trace?.droppedReasons,
    row.diagnostics?.memoryTrace?.dropped_reasons,
    row.diagnostics?.memoryTrace?.droppedReasons
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value.map((item) => normalizeText(item)).filter(Boolean);
  }
  return [];
}

function isMemoryRerankDroppedObservation(row = {}) {
  return extractDroppedReasons(row).some((reason) => /^rerank_(timeout|cooldown_timeout)/.test(reason));
}

function compactModelEvidence(row = {}, sourceType = 'model_call') {
  return {
    sourceType,
    at: isoFromMs(resolveRowMs(row)),
    module: rowModuleKey(row),
    source: rowSource(row),
    phase: rowPhase(row),
    purpose: normalizeText(row.purpose),
    status: normalizeText(row.status),
    error: normalizeText(row.error).slice(0, 180),
    finalErrorCode: normalizeText(row.final_error_code || row.finalErrorCode),
    statusCode: Number(row.status_code || row.statusCode || 0) || null,
    requestId: normalizeText(row.request_id || row.requestId),
    userId: normalizeText(row.user_id || row.userId),
    userRole: normalizeText(row.user_role || row.userRole),
    routePolicyKey: normalizeText(row.route_policy_key || row.routePolicyKey),
    topRouteType: normalizeText(row.top_route_type || row.topRouteType),
    model: normalizeText(row.model),
    host: normalizeText(row.host || row.api_base_url_host || row.apiBaseUrlHost)
  };
}

function compactLogEvidence(row = {}, module = 'runtime_log') {
  return {
    sourceType: 'runtime_log',
    at: isoFromMs(row.ms),
    module,
    file: row.file || path.basename(row.filePath || ''),
    lineNumber: row.lineNumber || 0,
    linePreview: normalizeText(row.line).slice(0, 220)
  };
}

function compactMemoryObservation(row = {}) {
  return {
    sourceType: 'memory_recall_observability',
    at: isoFromMs(resolveRowMs(row)),
    module: rowModuleKey({
      source: 'memory-v3',
      phase: normalizeText(row.stage || 'rerank')
    }),
    stage: normalizeText(row.stage),
    userId: normalizeText(row.userId),
    groupId: normalizeText(row.groupId),
    routePolicyKey: normalizeText(row.routePolicyKey),
    topRouteType: normalizeText(row.topRouteType),
    droppedReasons: extractDroppedReasons(row).filter((reason) => reason.startsWith('rerank_'))
  };
}

function summarizeSignal({
  code,
  title,
  count,
  countedEvidence,
  relatedEvidence,
  breakdown
}) {
  const counted = Array.isArray(countedEvidence) ? countedEvidence : [];
  const related = Array.isArray(relatedEvidence) ? relatedEvidence : [];
  const allEvidence = counted.concat(related);
  const lastMs = counted.reduce((max, item) => Math.max(max, Date.parse(item.at) || 0), 0);
  return {
    code,
    title,
    count: Math.max(0, Math.floor(normalizeNumber(count, counted.length))),
    lastOccurrenceAt: lastMs > 0 ? isoFromMs(lastMs) : '',
    affectedModules: countBy(allEvidence, (item) => item.module).slice(0, 10),
    affectedUsers: countBy(allEvidence, (item) => item.userId).filter((item) => item.key).slice(0, 10),
    affectedRoutes: countBy(allEvidence, (item) => item.routePolicyKey || item.topRouteType).slice(0, 10),
    breakdown,
    evidence: counted.slice(0, 20),
    relatedEvidence: related.slice(0, 20)
  };
}

function safeRuntimeStatus(options = {}) {
  if (options.runtimeStatus !== undefined) return options.runtimeStatus;
  try {
    const report = buildRuntimeStatusDiagnostic(options);
    return {
      overallStatus: report.summary?.overallStatus || 'unknown',
      signalCount: report.summary?.signalCount || 0,
      signals: Array.isArray(report.summary?.signals) ? report.summary.signals : [],
      mainProcess: report.summary?.mainProcess || {},
      postReplyWorker: report.summary?.postReplyWorker || {}
    };
  } catch (error) {
    return {
      overallStatus: 'error',
      signalCount: 1,
      signals: ['runtime_status_diagnostic_error'],
      error: normalizeText(error?.message || error)
    };
  }
}

function buildInputSummary({ modelCallFile, memoryRecallFile, logFiles, modelRows, memoryRows, logRows }) {
  return {
    modelCallLogFile: {
      path: modelCallFile,
      exists: Boolean(safeStat(modelCallFile)),
      windowRows: modelRows.length
    },
    memoryRecallObservabilityFile: {
      path: memoryRecallFile,
      exists: Boolean(safeStat(memoryRecallFile)),
      windowRows: memoryRows.length
    },
    runtimeLogFiles: logFiles.map((filePath) => ({
      path: filePath,
      exists: Boolean(safeStat(filePath)),
      windowLines: logRows.filter((row) => normalizePath(row.filePath) === normalizePath(filePath)).length
    }))
  };
}

function buildRuntimeExceptionDiagnostic(options = {}) {
  const now = nowMs(options);
  const windowMs = Math.max(
    60 * 1000,
    normalizeNumber(options.windowMs || process.env.RUNTIME_EXCEPTION_WINDOW_MS, DEFAULT_WINDOW_MS)
  );
  const sinceMs = now - windowMs;
  const untilMs = now;
  const maxLines = Math.max(100, Math.floor(normalizeNumber(options.maxLines || process.env.RUNTIME_EXCEPTION_MAX_LINES, DEFAULT_MAX_LINES)));

  const modelCallFile = resolveModelCallLogFile(options);
  const memoryRecallFile = resolveMemoryRecallLogFile(options);
  const logFiles = resolveRuntimeLogFiles(options);

  const modelRowsRaw = Array.isArray(options.modelCallRows)
    ? options.modelCallRows
    : readRecentJsonLines(modelCallFile, maxLines);
  const memoryRowsRaw = Array.isArray(options.memoryRecallRows)
    ? options.memoryRecallRows
    : readRecentJsonLines(memoryRecallFile, maxLines);
  const logRowsRaw = readRuntimeLogLines({ ...options, maxLines });

  const modelRows = filterWindow(modelRowsRaw, { sinceMs, untilMs });
  const memoryRows = filterWindow(memoryRowsRaw, { sinceMs, untilMs });
  const logRows = logRowsRaw.filter((row) => row.ms > 0 && row.ms >= sinceMs && row.ms <= untilMs);

  const adminActivations = logRows.filter(isAdminSharedActivationLog).map((row) => compactLogEvidence(row, 'mainModelFallback/admin_shared'));
  const adminPrimaryFailures = modelRows.filter(isAdminSharedPrimaryFailure).map((row) => compactModelEvidence(row));
  const adminFallbackActiveCalls = modelRows.filter(isAdminSharedFallbackActiveCall).map((row) => compactModelEvidence(row, 'fallback_active_model_call'));
  const adminCounted = adminActivations.length > 0 ? adminActivations : adminPrimaryFailures;

  const rerankerTimeoutLogs = logRows.filter(isMemoryRerankerTimeoutLog).map((row) => compactLogEvidence(row, 'memoryReranker'));
  const rerankerTimeoutModelCalls = modelRows.filter(isMemoryRerankerTimeoutModelCall).map((row) => compactModelEvidence(row));
  const rerankerDroppedObservations = memoryRows.filter(isMemoryRerankDroppedObservation).map(compactMemoryObservation);
  const rerankerCounted = rerankerTimeoutLogs.concat(rerankerTimeoutModelCalls, rerankerDroppedObservations);

  const signals = [
    summarizeSignal({
      code: 'main-model-fallback:admin_shared',
      title: 'admin shared main model fallback activation',
      count: adminCounted.length,
      countedEvidence: adminCounted,
      relatedEvidence: adminActivations.length > 0 ? adminPrimaryFailures.concat(adminFallbackActiveCalls) : adminFallbackActiveCalls,
      breakdown: {
        activationWarnings: adminActivations.length,
        primaryFailures: adminPrimaryFailures.length,
        fallbackActiveCalls: adminFallbackActiveCalls.length
      }
    }),
    summarizeSignal({
      code: 'memoryReranker-timeout-fallback',
      title: 'memory reranker timeout fallback to base recall',
      count: rerankerCounted.length,
      countedEvidence: rerankerCounted,
      relatedEvidence: [],
      breakdown: {
        timeoutWarnings: rerankerTimeoutLogs.length,
        timeoutModelFailures: rerankerTimeoutModelCalls.length,
        promptDropReasons: rerankerDroppedObservations.length
      }
    })
  ].filter((signal) => signal.count > 0 || Object.values(signal.breakdown || {}).some((value) => Number(value) > 0));

  const overallStatus = signals.length > 0 ? 'warning' : 'ok';
  const runtimeStatus = safeRuntimeStatus(options);

  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: isoFromMs(now),
    window: {
      since: isoFromMs(sinceMs),
      until: isoFromMs(untilMs),
      windowMs,
      maxLines
    },
    summary: {
      overallStatus,
      signalCount: signals.length,
      recentExceptionCount: signals.reduce((sum, signal) => sum + Math.max(0, Number(signal.count || 0) || 0), 0),
      lastExceptionAt: signals
        .map((signal) => Date.parse(signal.lastOccurrenceAt) || 0)
        .reduce((max, value) => Math.max(max, value), 0)
        ? isoFromMs(signals.map((signal) => Date.parse(signal.lastOccurrenceAt) || 0).reduce((max, value) => Math.max(max, value), 0))
        : '',
      affectedModules: mergeCountItems(signals.flatMap((signal) => signal.affectedModules || [])).slice(0, 10),
      signals: signals.map((signal) => signal.code)
    },
    runtimeStatus,
    inputs: buildInputSummary({
      modelCallFile,
      memoryRecallFile,
      logFiles,
      modelRows,
      memoryRows,
      logRows
    }),
    signals
  };
}

function formatWindow(windowMs = 0) {
  const ms = Math.max(0, normalizeNumber(windowMs, 0));
  if (ms >= 24 * 60 * 60 * 1000 && ms % (24 * 60 * 60 * 1000) === 0) return `${ms / (24 * 60 * 60 * 1000)}d`;
  if (ms >= 60 * 60 * 1000 && ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)}h`;
  if (ms >= 60 * 1000 && ms % (60 * 1000) === 0) return `${ms / (60 * 1000)}m`;
  return `${ms}ms`;
}

function buildRuntimeExceptionText(report = {}) {
  const summary = report.summary || {};
  const lines = [
    `runtime-exceptions: ${summary.overallStatus || 'unknown'} (${summary.recentExceptionCount || 0} recent exceptions, ${summary.signalCount || 0} signals) window=${formatWindow(report.window?.windowMs)}`,
    `last-exception: ${summary.lastExceptionAt || 'none'}`,
    `runtime-status: ${report.runtimeStatus?.overallStatus || 'unknown'} signals=${report.runtimeStatus?.signalCount || 0}`,
    `samples: modelCalls=${report.inputs?.modelCallLogFile?.windowRows || 0} memoryRecall=${report.inputs?.memoryRecallObservabilityFile?.windowRows || 0} runtimeLogs=${(report.inputs?.runtimeLogFiles || []).reduce((sum, item) => sum + (item.windowLines || 0), 0)}`
  ];

  if (Array.isArray(summary.affectedModules) && summary.affectedModules.length > 0) {
    lines.push(`affected-modules: ${summary.affectedModules.map((item) => `${item.key}:${item.count}`).join(', ')}`);
  }

  if (Array.isArray(report.signals) && report.signals.length > 0) {
    lines.push('signals:');
    for (const signal of report.signals) {
      const modules = Array.isArray(signal.affectedModules) && signal.affectedModules.length > 0
        ? signal.affectedModules.map((item) => `${item.key}:${item.count}`).join(', ')
        : 'none';
      const breakdown = Object.entries(signal.breakdown || {})
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
      lines.push(`- ${signal.code}: count=${signal.count} last=${signal.lastOccurrenceAt || 'none'} modules=${modules}${breakdown ? ` (${breakdown})` : ''}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_MAX_LINES,
  DEFAULT_WINDOW_MS,
  SCHEMA_VERSION,
  buildRuntimeExceptionDiagnostic,
  buildRuntimeExceptionText,
  isAdminSharedActivationLog,
  isAdminSharedPrimaryFailure,
  isMemoryRerankerTimeoutLog,
  isMemoryRerankerTimeoutModelCall,
  parseWindowMs
};

const path = require('path');
const config = require('../config');
const {
  buildRuntimeHotspotsDiagnostic,
  readRecentJsonLines
} = require('./runtimeHotspotsDiagnostics');
const {
  buildRuntimeStatusDiagnostic
} = require('./runtimeStatusDiagnostics');
const {
  buildLowResourceHealthReport
} = require('../scripts/diagnose-low-resource');
const {
  runProviderRequestDiagnostics
} = require('./providerRequestDiagnostics');
const {
  readModelCallLogRows
} = require('./mainReplyDiagnostics/cacheStats');
const {
  filterWindow,
  resolveEventMs
} = require('./runtimeHotspots/sampleFiles');

const SCHEMA_VERSION = 'main_reply_lag_diagnostic_v1';
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_MAX_LINES = 5000;
const MAIN_REPLY_MODEL_CALL_SOURCES = new Set([
  'v2_assistant_message',
  'v2_streaming_reply'
]);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  const n = normalizeNumber(value, fallback);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function parseWindowMs(value = '') {
  const text = normalizeText(value).toLowerCase();
  if (!text) return 0;
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = match[2] || 'm';
  if (unit === 'ms') return Math.round(amount);
  if (unit === 's') return Math.round(amount * 1000);
  if (unit === 'h') return Math.round(amount * 60 * 60 * 1000);
  return Math.round(amount * 60 * 1000);
}

function percentile(sortedValues = [], p = 0.5) {
  const values = sortedValues.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (values.length === 0) return 0;
  if (values.length === 1) return Math.round(values[0]);
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return Math.round(values[index]);
}

function summarizeDurations(rows = [], durationSelector = null) {
  const values = rows
    .map((row) => {
      const raw = typeof durationSelector === 'function' ? durationSelector(row) : row?.durationMs;
      return nonNegativeNumber(raw, NaN);
    })
    .filter((value) => Number.isFinite(value));
  const sorted = values.slice().sort((a, b) => a - b);
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    latestMs: values.length > 0 ? Math.round(values[values.length - 1]) : 0,
    maxMs: values.length > 0 ? Math.round(sorted[sorted.length - 1]) : 0,
    avgMs: values.length > 0 ? Math.round(sum / values.length) : 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95)
  };
}

function resolveDurationMs(row = {}, keys = []) {
  for (const key of keys) {
    const value = row?.[key];
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return NaN;
}

function eventType(row = {}) {
  return normalizeText(row.type || row.event || row.stage || row.tracePhase).toLowerCase();
}

function isPlannerEvent(row = {}) {
  const type = eventType(row);
  const stage = normalizeText(row.stage).toLowerCase();
  const moduleName = normalizeText(row.module || row.component || row.node).toLowerCase();
  return type.includes('planner_done')
    || stage.includes('planner_done')
    || (
      (moduleName === 'planner' || moduleName === 'direct_chat_planner')
      && Number.isFinite(resolveDurationMs(row, ['plannerDurationMs', 'durationMs', 'duration_ms']))
    );
}

function isSendEvent(row = {}) {
  const type = eventType(row);
  const stage = normalizeText(row.stage).toLowerCase();
  return type.includes('reply_send_success')
    || type.includes('reply_send_failure')
    || type.includes('final_reply_send_done')
    || stage.includes('reply_send_success')
    || stage.includes('reply_send_failure')
    || stage.includes('final_reply_send_done');
}

function isMainReplyModelCall(row = {}) {
  const source = normalizeText(row.source);
  if (MAIN_REPLY_MODEL_CALL_SOURCES.has(source)) return true;
  const topRouteType = normalizeText(row.top_route_type || row.topRouteType || row.model_route_diagnostic?.topRouteType);
  const route = normalizeText(row.route_debug_key || row.routeDebugKey || row.route_policy_key || row.routePolicyKey);
  return topRouteType === 'direct_chat' && /direct_chat|chat\/default|text_chat/i.test(route);
}

function readPerfEvents(options = {}) {
  if (Array.isArray(options.perfEvents)) return options.perfEvents;
  const maxLines = Math.max(100, Math.floor(normalizeNumber(options.maxLines, DEFAULT_MAX_LINES)));
  const perfFile = normalizeText(options.perfFile || config.PERF_LOG_FILE);
  const rows = perfFile ? readRecentJsonLines(perfFile, maxLines) : [];
  try {
    const { getRecentPerfEvents } = require('./perfRuntime');
    return rows.concat(getRecentPerfEvents({
      sinceMs: options.sinceMs,
      untilMs: options.untilMs,
      limit: maxLines
    }));
  } catch (_) {
    return rows;
  }
}

function readTraceEvents(options = {}) {
  if (Array.isArray(options.traceEvents)) return options.traceEvents;
  const maxLines = Math.max(100, Math.floor(normalizeNumber(options.maxLines, DEFAULT_MAX_LINES)));
  const traceFile = normalizeText(options.traceFile || path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'request-trace.ndjson'));
  return traceFile ? readRecentJsonLines(traceFile, maxLines) : [];
}

function readModelRows(options = {}) {
  if (Array.isArray(options.modelCallRows)) return options.modelCallRows;
  return readModelCallLogRows({
    logFile: options.modelCallLogFile,
    readLimit: options.maxLines || DEFAULT_MAX_LINES
  });
}

function filterRowsByWindow(rows = [], sinceMs = 0, untilMs = Date.now()) {
  return filterWindow(rows, { sinceMs, untilMs });
}

function summarizePlanner(perfEvents = []) {
  const rows = perfEvents.filter(isPlannerEvent);
  return {
    ...summarizeDurations(rows, (row) => resolveDurationMs(row, ['plannerDurationMs', 'durationMs', 'duration_ms'])),
    missing: rows.length === 0
  };
}

function summarizeSend(perfEvents = []) {
  const rows = perfEvents.filter(isSendEvent);
  return {
    ...summarizeDurations(rows, (row) => resolveDurationMs(row, ['sendDurationMs', 'durationMs', 'duration_ms'])),
    missing: rows.length === 0
  };
}

function summarizeMainModel(modelRows = []) {
  const rows = modelRows.filter(isMainReplyModelCall);
  const summary = summarizeDurations(rows, (row) => resolveDurationMs(row, [
    'mainModelDurationMs',
    'duration_ms',
    'durationMs',
    'elapsedMs'
  ]));
  const latest = rows.length > 0 ? rows[rows.length - 1] : null;
  return {
    ...summary,
    missing: rows.length === 0,
    latest: latest ? {
      status: normalizeText(latest.status),
      source: normalizeText(latest.source),
      provider: normalizeText(latest.provider),
      model: normalizeText(latest.model),
      host: normalizeText(latest.api_base_url_host || latest.host || latest.model_route_diagnostic?.apiBaseUrlHost),
      routeDebugKey: normalizeText(latest.route_debug_key || latest.routeDebugKey || latest.model_route_diagnostic?.routeDebugKey),
      finalErrorCode: normalizeText(latest.final_error_code || latest.finalErrorCode)
    } : null
  };
}

function summarizePostReplyPressure({ hotspots = {}, lowResource = {}, configObject = config } = {}) {
  const summary = hotspots.summary || {};
  const postReply = summary.postReplyWorker || {};
  const queue = postReply.queue || {};
  const processRss = summary.processRssMb || {};
  const thresholdMb = nonNegativeNumber(
    configObject.POST_REPLY_WORKER_RSS_RECYCLE_MB
    || lowResource.summary?.config?.postReplyWorkerRssRecycleMb,
    0
  );
  const rssMaxMb = nonNegativeNumber(processRss.postReplyMax, 0);
  const ratio = thresholdMb > 0 ? Number((rssMaxMb / thresholdMb).toFixed(3)) : null;
  const pressure = thresholdMb > 0 && rssMaxMb >= thresholdMb
    ? 'critical'
    : (thresholdMb > 0 && rssMaxMb >= thresholdMb * 0.8 ? 'warning' : 'ok');
  return {
    status: normalizeText(postReply.status || lowResource.summary?.postReplyWorker?.status || 'unknown'),
    rssMaxMb,
    recycleThresholdMb: thresholdMb,
    pressure,
    pressureRatio: ratio,
    processCount: nonNegativeNumber(postReply.processCount, 0),
    activeMax: nonNegativeNumber(postReply.active?.max, 0),
    queue: {
      queued: nonNegativeNumber(queue.queued, 0),
      processing: nonNegativeNumber(queue.processing, 0),
      failed: nonNegativeNumber(queue.failed, 0)
    },
    lowResourceOk: lowResource.ok === true,
    lowResourceFailedChecks: Array.isArray(lowResource.failedChecks) ? lowResource.failedChecks.slice() : []
  };
}

function scoreBottleneck(report = {}) {
  const metrics = report.metrics || {};
  const candidates = [
    {
      code: 'planner',
      label: 'planner 耗时',
      score: nonNegativeNumber(metrics.planner?.p95Ms || metrics.planner?.maxMs, 0),
      evidence: `planner p95=${metrics.planner?.p95Ms || 0}ms max=${metrics.planner?.maxMs || 0}ms`
    },
    {
      code: 'main_model',
      label: '主模型耗时',
      score: nonNegativeNumber(metrics.mainModel?.p95Ms || metrics.mainModel?.maxMs, 0),
      evidence: `mainModel p95=${metrics.mainModel?.p95Ms || 0}ms max=${metrics.mainModel?.maxMs || 0}ms`
    },
    {
      code: 'send',
      label: '发送耗时',
      score: nonNegativeNumber(metrics.send?.p95Ms || metrics.send?.maxMs, 0),
      evidence: `send p95=${metrics.send?.p95Ms || 0}ms max=${metrics.send?.maxMs || 0}ms`
    },
    {
      code: 'post_reply_rss',
      label: 'post-reply worker RSS 压力',
      score: metrics.postReplyWorker?.pressure === 'critical'
        ? 120000
        : (metrics.postReplyWorker?.pressure === 'warning' ? 45000 : 0),
      evidence: `postReply rssMax=${metrics.postReplyWorker?.rssMaxMb || 0}MB threshold=${metrics.postReplyWorker?.recycleThresholdMb || 0}MB`
    }
  ];
  const known = candidates.filter((item) => item.score > 0);
  if (known.length === 0) {
    return {
      code: 'unknown',
      label: '样本不足',
      evidence: '缺少 planner、主模型、发送耗时或 RSS 压力样本'
    };
  }
  known.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return {
    code: known[0].code,
    label: known[0].label,
    evidence: known[0].evidence
  };
}

async function buildMainReplyLagDiagnostic(options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const untilMs = now instanceof Date ? now.getTime() : nonNegativeNumber(now, Date.now());
  const windowMs = Math.max(60 * 1000, nonNegativeNumber(options.windowMs, DEFAULT_WINDOW_MS));
  const sinceMs = untilMs - windowMs;
  const maxLines = Math.max(100, Math.floor(nonNegativeNumber(options.maxLines, DEFAULT_MAX_LINES)));
  const perfEvents = filterRowsByWindow(readPerfEvents({
    ...options,
    sinceMs,
    untilMs,
    maxLines
  }), sinceMs, untilMs);
  const traceEvents = filterRowsByWindow(readTraceEvents({
    ...options,
    maxLines
  }), sinceMs, untilMs);
  const latencyEvents = perfEvents.concat(traceEvents);
  const modelRows = filterRowsByWindow(readModelRows({
    ...options,
    maxLines
  }), sinceMs, untilMs);
  const status = options.status || buildRuntimeStatusDiagnostic(options);
  const hotspots = options.hotspots || buildRuntimeHotspotsDiagnostic({
    ...options,
    runtimeStatus: status,
    windowMs,
    maxLines
  });
  const lowResource = options.lowResource || buildLowResourceHealthReport({
    ...options,
    status,
    hotspots
  });
  const providerRequest = options.includeProvider === true
    ? await runProviderRequestDiagnostics({
        provider: options.provider,
        scenarios: options.providerScenarios || 'main_reply'
      })
    : null;

  const metrics = {
    planner: summarizePlanner(latencyEvents),
    mainModel: summarizeMainModel(modelRows),
    send: summarizeSend(latencyEvents),
    postReplyWorker: summarizePostReplyPressure({
      hotspots,
      lowResource,
      configObject: options.config || config
    })
  };
  const report = {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: new Date(untilMs).toISOString(),
    window: {
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      windowMs,
      maxLines
    },
    summary: {
      plannerP95Ms: metrics.planner.p95Ms,
      mainModelP95Ms: metrics.mainModel.p95Ms,
      sendP95Ms: metrics.send.p95Ms,
      postReplyWorkerRssMaxMb: metrics.postReplyWorker.rssMaxMb,
      postReplyWorkerPressure: metrics.postReplyWorker.pressure,
      missingFields: []
    },
    metrics,
    providerRequest,
    inputs: {
      perfEvents: perfEvents.length,
      traceEvents: traceEvents.length,
      modelCallRows: modelRows.length,
      perfLogFile: normalizeText(options.perfFile || config.PERF_LOG_FILE),
      traceFile: normalizeText(options.traceFile || path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'request-trace.ndjson')),
      modelCallLogFile: normalizeText(options.modelCallLogFile || path.join(config.DATA_DIR || path.join(process.cwd(), 'data'), 'model-calls.ndjson'))
    },
    diagnostics: {
      runtimeStatus: status.summary || {},
      hotspots: hotspots.summary || {},
      lowResource: {
        ok: lowResource.ok === true,
        failedChecks: Array.isArray(lowResource.failedChecks) ? lowResource.failedChecks.slice() : []
      }
    }
  };
  if (metrics.planner.missing) report.summary.missingFields.push('planner_duration');
  if (metrics.mainModel.missing) report.summary.missingFields.push('main_model_duration');
  if (metrics.send.missing) report.summary.missingFields.push('send_duration');
  if (!metrics.postReplyWorker.rssMaxMb) report.summary.missingFields.push('post_reply_worker_rss');
  report.summary.mostLikelyBottleneck = scoreBottleneck(report);
  return report;
}

function buildMainReplyLagDiagnosticText(report = {}) {
  const summary = report.summary || {};
  const metrics = report.metrics || {};
  const queue = metrics.postReplyWorker?.queue || {};
  const lines = [
    `main-reply-lag: bottleneck=${summary.mostLikelyBottleneck?.code || 'unknown'} (${summary.mostLikelyBottleneck?.label || 'unknown'}) window=${Math.round(nonNegativeNumber(report.window?.windowMs, 0) / 60000)}m`,
    `planner: p50=${metrics.planner?.p50Ms || 0}ms p95=${metrics.planner?.p95Ms || 0}ms max=${metrics.planner?.maxMs || 0}ms samples=${metrics.planner?.count || 0}`,
    `main-model: p50=${metrics.mainModel?.p50Ms || 0}ms p95=${metrics.mainModel?.p95Ms || 0}ms max=${metrics.mainModel?.maxMs || 0}ms samples=${metrics.mainModel?.count || 0} provider=${metrics.mainModel?.latest?.provider || ''} model=${metrics.mainModel?.latest?.model || ''}`,
    `send: p50=${metrics.send?.p50Ms || 0}ms p95=${metrics.send?.p95Ms || 0}ms max=${metrics.send?.maxMs || 0}ms samples=${metrics.send?.count || 0}`,
    `post-reply-rss: pressure=${metrics.postReplyWorker?.pressure || 'unknown'} rssMax=${metrics.postReplyWorker?.rssMaxMb || 0}MB threshold=${metrics.postReplyWorker?.recycleThresholdMb || 0}MB activeMax=${metrics.postReplyWorker?.activeMax || 0} queue=queued:${queue.queued || 0} processing:${queue.processing || 0} failed:${queue.failed || 0}`,
    `evidence: ${summary.mostLikelyBottleneck?.evidence || ''}`
  ];
  if (Array.isArray(summary.missingFields) && summary.missingFields.length > 0) {
    lines.push(`missing-fields: ${summary.missingFields.join(', ')}`);
  }
  if (report.providerRequest) {
    const anomalies = Array.isArray(report.providerRequest.anomalies) ? report.providerRequest.anomalies : [];
    lines.push(`provider-request: scenarios=${Array.isArray(report.providerRequest.scenarios) ? report.providerRequest.scenarios.length : 0} anomalies=${anomalies.length} requested=${report.providerRequest.requested?.provider || ''}`);
    if (anomalies.length > 0) {
      lines.push(`provider-anomalies: ${anomalies.join(', ')}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  buildMainReplyLagDiagnostic,
  buildMainReplyLagDiagnosticText,
  filterRowsByWindow,
  isMainReplyModelCall,
  isPlannerEvent,
  isSendEvent,
  parseWindowMs,
  resolveEventMs,
  scoreBottleneck,
  summarizeDurations,
  summarizeMainModel,
  summarizePlanner,
  summarizeSend
};

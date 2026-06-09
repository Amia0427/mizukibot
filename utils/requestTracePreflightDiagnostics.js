const fs = require('fs');
const path = require('path');

const DEFAULT_TRACE_FILE = path.join(process.cwd(), 'data', 'request-trace.ndjson');
const DEFAULT_MAX_LINES = 20000;
const DEFAULT_SLOW_MS = 1000;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseDurationMs(value = '') {
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

function parseArgs(argv = []) {
  const items = Array.isArray(argv) ? argv.slice() : [];
  const args = items[0] === 'node' || /node(?:\.exe)?$/i.test(String(items[0] || ''))
    ? items.slice(2)
    : items;
  const parsed = {
    traceFile: DEFAULT_TRACE_FILE,
    requestIds: [],
    limit: 20,
    maxLines: DEFAULT_MAX_LINES,
    sinceMs: 0,
    slowMs: DEFAULT_SLOW_MS,
    json: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const item = normalizeText(args[i]);
    if (!item) continue;
    if (item === '--json') parsed.json = true;
    else if (item === '--trace-file') {
      parsed.traceFile = normalizeText(args[i + 1]) || parsed.traceFile;
      i += 1;
    } else if (item.startsWith('--trace-file=')) {
      parsed.traceFile = normalizeText(item.slice('--trace-file='.length)) || parsed.traceFile;
    } else if (item === '--request-id' || item === '--id') {
      const value = normalizeText(args[i + 1]);
      if (value) parsed.requestIds.push(...value.split(',').map(normalizeText).filter(Boolean));
      i += 1;
    } else if (item.startsWith('--request-id=')) {
      parsed.requestIds.push(...item.slice('--request-id='.length).split(',').map(normalizeText).filter(Boolean));
    } else if (item.startsWith('--id=')) {
      parsed.requestIds.push(...item.slice('--id='.length).split(',').map(normalizeText).filter(Boolean));
    } else if (item === '--limit') {
      parsed.limit = Math.max(1, normalizeNumber(args[i + 1], parsed.limit));
      i += 1;
    } else if (item.startsWith('--limit=')) {
      parsed.limit = Math.max(1, normalizeNumber(item.slice('--limit='.length), parsed.limit));
    } else if (item === '--max-lines') {
      parsed.maxLines = Math.max(100, normalizeNumber(args[i + 1], parsed.maxLines));
      i += 1;
    } else if (item.startsWith('--max-lines=')) {
      parsed.maxLines = Math.max(100, normalizeNumber(item.slice('--max-lines='.length), parsed.maxLines));
    } else if (item === '--since' || item === '--window') {
      parsed.sinceMs = parseDurationMs(args[i + 1]);
      i += 1;
    } else if (item.startsWith('--since=')) {
      parsed.sinceMs = parseDurationMs(item.slice('--since='.length));
    } else if (item.startsWith('--window=')) {
      parsed.sinceMs = parseDurationMs(item.slice('--window='.length));
    } else if (item === '--slow-ms') {
      parsed.slowMs = Math.max(0, normalizeNumber(args[i + 1], parsed.slowMs));
      i += 1;
    } else if (item.startsWith('--slow-ms=')) {
      parsed.slowMs = Math.max(0, normalizeNumber(item.slice('--slow-ms='.length), parsed.slowMs));
    } else if (!item.startsWith('-')) {
      parsed.requestIds.push(...item.split(',').map(normalizeText).filter(Boolean));
    }
  }
  parsed.requestIds = Array.from(new Set(parsed.requestIds));
  return parsed;
}

function readRecentJsonLines(filePath = DEFAULT_TRACE_FILE, maxLines = DEFAULT_MAX_LINES) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const selected = lines.slice(-Math.max(1, Number(maxLines) || DEFAULT_MAX_LINES));
  const rows = [];
  for (const line of selected) {
    try {
      rows.push(JSON.parse(line));
    } catch (_) {}
  }
  return rows;
}

function eventMs(event = {}) {
  const recorded = Date.parse(event.recordedAt || event.ts || event.time || '');
  if (Number.isFinite(recorded)) return recorded;
  const started = Number(event.requestStartedAt || 0);
  const elapsed = Number(event.elapsedSinceRequestStartMs || 0);
  if (Number.isFinite(started) && started > 0 && Number.isFinite(elapsed)) return started + elapsed;
  return 0;
}

function firstEvent(events = [], phases = []) {
  const phaseSet = new Set(phases);
  return events.find((event) => phaseSet.has(normalizeText(event.tracePhase || event.stage)));
}

function firstBy(events = [], predicate = null) {
  if (typeof predicate !== 'function') return null;
  return events.find(predicate) || null;
}

function elapsed(event = null) {
  if (!event || event.elapsedSinceRequestStartMs === null || event.elapsedSinceRequestStartMs === undefined) return null;
  const n = Number(event?.elapsedSinceRequestStartMs);
  return Number.isFinite(n) ? n : null;
}

function elapsedFromStart(event = null, ingress = null) {
  const direct = elapsed(event);
  if (direct !== null) return direct;
  const eventTime = eventMs(event || {});
  const ingressTime = eventMs(ingress || {});
  if (eventTime > 0 && ingressTime > 0) return Math.max(0, eventTime - ingressTime);
  return null;
}

function duration(event = null) {
  if (!event || event.durationMs === null || event.durationMs === undefined) return null;
  const n = Number(event?.durationMs);
  return Number.isFinite(n) ? n : null;
}

function deltaBetween(left = null, right = null) {
  const leftMs = eventMs(left || {});
  const rightMs = eventMs(right || {});
  if (leftMs > 0 && rightMs > 0) return Math.max(0, rightMs - leftMs);
  const leftElapsed = elapsed(left);
  const rightElapsed = elapsed(right);
  if (leftElapsed !== null && rightElapsed !== null) return Math.max(0, rightElapsed - leftElapsed);
  return null;
}

function summarizePrepareEvents(events = []) {
  const prepareEvents = events.filter((event) => normalizeText(event.node) === 'prepare');
  const latencyProfile = prepareEvents.find((event) => normalizeText(event.stage || event.tracePhase) === 'latency_profile') || null;
  return {
    eventCount: prepareEvents.length,
    fastPath: normalizeText(latencyProfile?.fastPath),
    firstPhase: normalizeText(prepareEvents[0]?.tracePhase || prepareEvents[0]?.stage),
    lastPhase: normalizeText(prepareEvents[prepareEvents.length - 1]?.tracePhase || prepareEvents[prepareEvents.length - 1]?.stage)
  };
}

function pickDominant(segments = {}) {
  const candidates = Object.entries(segments)
    .map(([code, ms]) => ({ code, ms: Number(ms) }))
    .filter((item) => Number.isFinite(item.ms))
    .sort((a, b) => b.ms - a.ms);
  return candidates[0] || { code: 'unknown', ms: 0 };
}

function summarizeRequest(events = [], options = {}) {
  const sorted = events.slice().sort((a, b) => {
    const seqA = Number(a.phaseSeq || 0);
    const seqB = Number(b.phaseSeq || 0);
    if (seqA || seqB) return seqA - seqB;
    return eventMs(a) - eventMs(b);
  });
  const ingress = firstEvent(sorted, ['message_ingress', 'handle_incoming_start']);
  const lock = firstEvent(sorted, ['message_ingress_lock_acquired', 'inbound_lock_acquired']);
  const routeEntry = firstEvent(sorted, ['message_ingress_route_entry', 'inbound_route_entry']);
  const routerStart = firstEvent(sorted, ['router_start', 'route_resolver_start']);
  const plannerStart = firstEvent(sorted, ['planner_start', 'direct_chat_planner_start']);
  const plannerDone = firstEvent(sorted, ['planner_done', 'direct_chat_planner_done']);
  const dispatchStart = firstEvent(sorted, ['runtime_dispatch_start', 'formal_route_dispatch_start']);
  const dispatchSelected = firstEvent(sorted, ['dispatch_branch_selected']);
  const prepareStart = firstBy(sorted, (event) => normalizeText(event.node) === 'prepare' && normalizeText(event.stage) === 'node_start');
  const routeNodeDone = firstBy(sorted, (event) => normalizeText(event.node) === 'route' && normalizeText(event.stage) === 'node_complete');
  const upstreamStart = firstBy(sorted, (event) => normalizeText(event.tracePhase) === 'http_client_start' && normalizeText(event.source) === 'v2_streaming_reply');
  const upstreamSuccess = firstBy(sorted, (event) => normalizeText(event.tracePhase) === 'http_client_success' && normalizeText(event.source) === 'v2_streaming_reply');
  const requestComplete = firstEvent(sorted.slice().reverse(), ['request_complete']);
  const finalSend = firstEvent(sorted.slice().reverse(), ['final_reply_send_done']);
  const segments = {
    ingressToLockMs: deltaBetween(ingress, lock),
    lockToRouteEntryMs: deltaBetween(lock, routeEntry),
    routeEntryToRouterStartMs: deltaBetween(routeEntry, routerStart),
    plannerMs: duration(plannerDone) ?? deltaBetween(plannerStart, plannerDone),
    dispatchToPrepareMs: deltaBetween(dispatchSelected || dispatchStart, prepareStart),
    prepareAndRouteToUpstreamMs: deltaBetween(prepareStart, upstreamStart),
    dispatchToUpstreamMs: deltaBetween(dispatchSelected || dispatchStart, upstreamStart),
    upstreamMs: duration(upstreamSuccess) ?? deltaBetween(upstreamStart, upstreamSuccess),
    sendEnvelopeMs: duration(finalSend),
    totalMs: duration(requestComplete) ?? elapsed(requestComplete)
  };
  const dominantPreUpstream = pickDominant({
    ingress_queue_or_event_loop: segments.ingressToLockMs,
    route_pre_resolver_gap: segments.routeEntryToRouterStartMs,
    planner: segments.plannerMs,
    dispatch_pre_model_gap: segments.dispatchToPrepareMs,
    prepare_route_to_upstream: segments.prepareAndRouteToUpstreamMs
  });
  return {
    requestId: normalizeText(sorted[0]?.requestId),
    recordedAt: normalizeText(ingress?.recordedAt || sorted[0]?.recordedAt),
    messageId: normalizeText(ingress?.messageId || sorted.find((event) => event.messageId)?.messageId),
    chatType: normalizeText(ingress?.chatType || sorted.find((event) => event.chatType)?.chatType),
    userId: normalizeText(ingress?.userId || sorted.find((event) => event.userId)?.userId),
    routePolicyKey: normalizeText(dispatchSelected?.routePolicyKey || requestComplete?.routePolicyKey),
    routeDebugKey: normalizeText(dispatchSelected?.routeDebugKey || finalSend?.routeDebugKey),
    allowTools: dispatchSelected?.allowTools === true,
    shouldUseTools: plannerDone?.shouldUseTools === true,
    plannerDecisionSource: normalizeText(plannerDone?.decisionSource || plannerDone?.plannerDecisionSource),
    upstreamStartedAtMs: elapsedFromStart(upstreamStart, ingress),
    segments,
    prepare: summarizePrepareEvents(sorted),
    dominantPreUpstream,
    slowFlags: Object.fromEntries(
      Object.entries(segments)
        .filter(([_, value]) => Number.isFinite(Number(value)) && Number(value) >= Number(options.slowMs || DEFAULT_SLOW_MS))
        .map(([key, value]) => [key, Math.round(Number(value))])
    )
  };
}

function buildRequestTracePreflightDiagnostic(options = {}) {
  const rows = Array.isArray(options.rows)
    ? options.rows
    : readRecentJsonLines(options.traceFile || DEFAULT_TRACE_FILE, options.maxLines || DEFAULT_MAX_LINES);
  const untilMs = Number(options.nowMs || Date.now());
  const sinceMs = Number(options.sinceMs || 0) > 0 ? untilMs - Number(options.sinceMs) : 0;
  const wanted = new Set((options.requestIds || []).map(normalizeText).filter(Boolean));
  const grouped = new Map();
  for (const row of rows) {
    const requestId = normalizeText(row.requestId);
    if (!requestId) continue;
    if (wanted.size > 0 && !wanted.has(requestId)) continue;
    if (sinceMs > 0) {
      const ms = eventMs(row);
      if (ms > 0 && ms < sinceMs) continue;
    }
    if (!grouped.has(requestId)) grouped.set(requestId, []);
    grouped.get(requestId).push(row);
  }
  const requests = Array.from(grouped.values())
    .map((events) => summarizeRequest(events, { slowMs: options.slowMs }))
    .filter((item) => item.requestId)
    .sort((a, b) => {
      const aMs = Date.parse(a.recordedAt || '') || 0;
      const bMs = Date.parse(b.recordedAt || '') || 0;
      return bMs - aMs;
    })
    .slice(0, Math.max(1, Number(options.limit || 20) || 20));
  return {
    schemaVersion: 'request_trace_preflight_diagnostic_v1',
    traceFile: normalizeText(options.traceFile || DEFAULT_TRACE_FILE),
    inputs: {
      rows: rows.length,
      requestIds: Array.from(wanted),
      limit: Math.max(1, Number(options.limit || 20) || 20),
      slowMs: Math.max(0, Number(options.slowMs || DEFAULT_SLOW_MS) || 0)
    },
    requests
  };
}

function formatMs(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}ms` : 'n/a';
}

function formatRequestTracePreflightDiagnostic(report = {}) {
  const lines = [
    `request-trace-preflight: requests=${report.requests?.length || 0} trace=${report.traceFile || ''}`
  ];
  for (const request of report.requests || []) {
    lines.push([
      `- ${request.requestId}`,
      `route=${request.routePolicyKey || 'unknown'}`,
      `allowTools=${request.allowTools}`,
      `upstreamStart=${formatMs(request.upstreamStartedAtMs)}`,
      `dominant=${request.dominantPreUpstream?.code || 'unknown'}:${formatMs(request.dominantPreUpstream?.ms)}`
    ].join(' '));
    lines.push([
      '  pre-upstream:',
      `ingressToLock=${formatMs(request.segments.ingressToLockMs)}`,
      `routeGap=${formatMs(request.segments.routeEntryToRouterStartMs)}`,
      `planner=${formatMs(request.segments.plannerMs)}`,
      `dispatchToPrepare=${formatMs(request.segments.dispatchToPrepareMs)}`,
      `prepareToUpstream=${formatMs(request.segments.prepareAndRouteToUpstreamMs)}`
    ].join(' '));
    lines.push([
      '  upstream:',
      `mainModel=${formatMs(request.segments.upstreamMs)}`,
      `total=${formatMs(request.segments.totalMs)}`,
      `prepareFastPath=${request.prepare.fastPath || 'none'}`
    ].join(' '));
  }
  return lines.join('\n');
}

module.exports = {
  buildRequestTracePreflightDiagnostic,
  formatRequestTracePreflightDiagnostic,
  parseArgs,
  parseDurationMs,
  readRecentJsonLines,
  summarizeRequest
};

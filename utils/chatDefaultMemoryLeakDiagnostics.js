const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DEFAULT_MAX_LINES = 50000;
const DEFAULT_LIMIT = 50;
const LEAK_BLOCK_IDS = ['retrieved_memory_lite', 'daily_journal', 'memory_recall_policy'];
const MAIN_REPLY_SOURCES = new Set([
  'v2_streaming_reply',
  'direct_reply',
  'normal_fast_reply',
  'draft_reply'
]);

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  const unit = match[2] || 'h';
  if (unit === 'ms') return Math.round(amount);
  if (unit === 's') return Math.round(amount * 1000);
  if (unit === 'm') return Math.round(amount * 60 * 1000);
  if (unit === 'd') return Math.round(amount * 24 * 60 * 60 * 1000);
  return Math.round(amount * 60 * 60 * 1000);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dataDir: DEFAULT_DATA_DIR,
    modelCallsFile: '',
    requestTraceFile: '',
    observabilityFile: '',
    maxLines: DEFAULT_MAX_LINES,
    limit: DEFAULT_LIMIT,
    sinceMs: 0,
    json: false,
    text: false,
    includeAdmin: true,
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
    } else if (key === '--observability') {
      const { value, consumed } = readArgValue(argv, i);
      options.observabilityFile = path.resolve(String(value || ''));
      i += consumed;
    } else if (key === '--max-lines') {
      const { value, consumed } = readArgValue(argv, i);
      options.maxLines = Math.max(100, Math.floor(normalizeNumber(value, DEFAULT_MAX_LINES)));
      i += consumed;
    } else if (key === '--limit') {
      const { value, consumed } = readArgValue(argv, i);
      options.limit = Math.max(1, Math.floor(normalizeNumber(value, DEFAULT_LIMIT)));
      i += consumed;
    } else if (key === '--since' || key === '--window') {
      const { value, consumed } = readArgValue(argv, i);
      options.sinceMs = parseDurationMs(value);
      i += consumed;
    } else if (key === '--json') {
      options.json = true;
    } else if (key === '--text') {
      options.text = true;
    } else if (key === '--exclude-admin') {
      options.includeAdmin = false;
    }
  }

  if (!options.json && !options.text) options.text = true;
  return options;
}

function resolveInputFiles(options = {}) {
  const dataDir = path.resolve(options.dataDir || DEFAULT_DATA_DIR);
  return {
    dataDir,
    modelCallsFile: path.resolve(options.modelCallsFile || path.join(dataDir, 'model-calls.ndjson')),
    requestTraceFile: path.resolve(options.requestTraceFile || path.join(dataDir, 'request-trace.ndjson')),
    observabilityFile: path.resolve(options.observabilityFile || path.join(dataDir, 'memory-recall-observability.ndjson'))
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
  for (const key of ['ts', 'completed_at', 'started_at', 'recordedAt', 'createdAt', 'updatedAt']) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  const requestStartedAt = Number(row.requestStartedAt || 0);
  const elapsed = Number(row.elapsedSinceRequestStartMs || 0);
  if (Number.isFinite(requestStartedAt) && requestStartedAt > 0) {
    return requestStartedAt + (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0);
  }
  return 0;
}

function filterRowsByWindow(rows = [], options = {}) {
  const sinceMs = Number(options.sinceMs || 0) > 0 ? Number(options.nowMs || Date.now()) - Number(options.sinceMs) : 0;
  if (!sinceMs) return rows;
  return rows.filter((row) => {
    const ms = rowTimeMs(row);
    return ms === 0 || ms >= sinceMs;
  });
}

function compactEvidence(value = '', maxChars = 140) {
  const text = normalizeText(value).replace(/\s+/g, ' ');
  const limit = Math.max(20, Math.floor(normalizeNumber(maxChars, 140)));
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 12)).trim()} [truncated]`;
}

function includesBlockId(ids = [], blockId = '') {
  const target = normalizeText(blockId);
  return normalizeArray(ids).map((item) => normalizeText(item)).some((id) => id === target || id === `${target}_compact`);
}

function collectBlockEvidenceFromModelCall(row = {}) {
  const integrity = normalizeObject(row.prompt_integrity, {});
  const markers = normalizeObject(integrity.memory_markers, {});
  const evidence = [];
  const blocks = new Set();

  if (integrity.has_retrieved_memory === true || normalizeNumber(markers.retrieved_memory, 0) > 0) {
    blocks.add('retrieved_memory_lite');
    evidence.push({
      source: 'model-calls.prompt_integrity',
      blockId: 'retrieved_memory_lite',
      detail: `has_retrieved_memory=${integrity.has_retrieved_memory === true} markers=${normalizeNumber(markers.retrieved_memory, 0)}`
    });
  }
  if (integrity.has_daily_journal === true || normalizeNumber(markers.daily_journal, 0) > 0) {
    blocks.add('daily_journal');
    evidence.push({
      source: 'model-calls.prompt_integrity',
      blockId: 'daily_journal',
      detail: `has_daily_journal=${integrity.has_daily_journal === true} markers=${normalizeNumber(markers.daily_journal, 0)}`
    });
  }
  const directIds = [
    ...normalizeArray(row.injected_block_ids),
    ...normalizeArray(row.dynamic_block_ids),
    ...normalizeArray(row.prompt_block_ids),
    ...normalizeArray(row.prompt?.dynamicBlockIds)
  ];
  for (const blockId of LEAK_BLOCK_IDS) {
    if (!includesBlockId(directIds, blockId)) continue;
    blocks.add(blockId);
    evidence.push({
      source: 'model-calls.block_ids',
      blockId,
      detail: `block id present on model call`
    });
  }

  return { blocks: Array.from(blocks), evidence };
}

function collectBlockEvidenceFromObservation(row = {}) {
  const prompt = normalizeObject(row.prompt, {});
  const memoryTrace = normalizeObject(row.memoryTrace, normalizeObject(row.localMemory?.trace, {}));
  const dynamicBlockIds = normalizeArray(prompt.dynamicBlockIds);
  const injectedBlockIds = normalizeArray(memoryTrace.injected_block_ids);
  const plannerEnabled = normalizeArray(row.planner?.enabledBlockIds);
  const evidence = [];
  const blocks = new Set();

  const blockChecks = [
    ['retrieved_memory_lite', prompt.hasRetrievedMemoryLite === true],
    ['daily_journal', includesBlockId(dynamicBlockIds, 'daily_journal')],
    ['memory_recall_policy', includesBlockId(dynamicBlockIds, 'memory_recall_policy')
      || includesBlockId(injectedBlockIds, 'memory_recall_policy')
      || includesBlockId(plannerEnabled, 'memory_recall_policy')]
  ];

  for (const [blockId, hit] of blockChecks) {
    if (!hit) continue;
    blocks.add(blockId);
    evidence.push({
      source: 'memory-recall-observability.prompt',
      blockId,
      detail: `dynamic=${includesBlockId(dynamicBlockIds, blockId)} injected=${includesBlockId(injectedBlockIds, blockId)} planner=${includesBlockId(plannerEnabled, blockId)}`
    });
  }

  return { blocks: Array.from(blocks), evidence };
}

function routePolicyKeyOf(row = {}) {
  return normalizeText(row.route_policy_key || row.routePolicyKey || row.model_route_diagnostic?.routePolicyKey);
}

function routeDebugKeyOf(row = {}) {
  return normalizeText(row.route_debug_key || row.routeDebugKey || row.model_route_diagnostic?.routeDebugKey);
}

function topRouteTypeOf(row = {}) {
  return normalizeText(row.top_route_type || row.topRouteType || row.model_route_diagnostic?.topRouteType);
}

function dispatchBranchOf(row = {}) {
  return normalizeText(row.dispatch_branch || row.dispatchBranch || row.model_route_diagnostic?.branch);
}

function isChatDefault(row = {}) {
  return routePolicyKeyOf(row) === 'chat/default';
}

function isOrdinaryMainReplyModelCall(row = {}) {
  const source = normalizeText(row.source);
  if (!source || !MAIN_REPLY_SOURCES.has(source)) return false;
  if (!isChatDefault(row)) return false;
  const topRouteType = topRouteTypeOf(row);
  if (topRouteType && topRouteType !== 'direct_chat') return false;
  return normalizeText(row.request_id || row.requestId) !== '';
}

function groupTraceByRequestId(rows = []) {
  const byRequestId = new Map();
  for (const row of rows) {
    const requestId = normalizeText(row.requestId || row.request_id);
    if (!requestId) continue;
    if (!byRequestId.has(requestId)) byRequestId.set(requestId, []);
    byRequestId.get(requestId).push(row);
  }
  for (const events of byRequestId.values()) {
    events.sort((a, b) => {
      const seqA = normalizeNumber(a.phaseSeq || a.phase_seq, 0);
      const seqB = normalizeNumber(b.phaseSeq || b.phase_seq, 0);
      if (seqA || seqB) return seqA - seqB;
      return rowTimeMs(a) - rowTimeMs(b);
    });
  }
  return byRequestId;
}

function groupObservationsByRequestId(rows = []) {
  const byRequestId = new Map();
  for (const row of rows) {
    const requestId = normalizeText(row.requestId || row.request_id);
    if (!requestId) continue;
    if (!byRequestId.has(requestId)) byRequestId.set(requestId, []);
    byRequestId.get(requestId).push(row);
  }
  for (const list of byRequestId.values()) {
    list.sort((a, b) => rowTimeMs(a) - rowTimeMs(b));
  }
  return byRequestId;
}

function rowHasExplicitRecallSignal(row = {}) {
  const truthyFields = [
    row.needsMemory,
    row.needs_memory,
    row.forceMemoryContext,
    row.force_memory_context,
    row.intent?.needsMemory,
    row.route?.intent?.needsMemory,
    row.meta?.needsMemory,
    row.routeMeta?.intent?.needsMemory
  ];
  if (truthyFields.some((value) => value === true || normalizeText(value).toLowerCase() === 'true')) return true;

  const textFields = [
    row.needsMemoryReason,
    row.needs_memory_reason,
    row.recallFacet,
    row.recall_facet,
    row.meta?.needsMemoryReason,
    row.meta?.recallFacet,
    row.routeMeta?.needsMemoryReason,
    row.routeMeta?.recallFacet,
    row.intent?.memoryReason,
    row.route?.intent?.memoryReason
  ].map((value) => normalizeText(value)).filter(Boolean);
  if (textFields.length > 0) return true;

  const route = routePolicyKeyOf(row);
  if (route && route !== 'chat/default' && /(?:lookup|memory|notebook|recall|journal)/i.test(route)) return true;
  const routeDebug = routeDebugKeyOf(row);
  if (/(?:memory|recall|journal|notebook)/i.test(routeDebug)) return true;
  return false;
}

function summarizeExplicitRecallEvidence(modelCall = {}, traceEvents = [], observations = []) {
  const evidence = [];
  const add = (source, detail) => {
    const normalized = compactEvidence(detail);
    if (normalized) evidence.push({ source, detail: normalized });
  };

  if (rowHasExplicitRecallSignal(modelCall)) {
    add('model-calls', [
      `route=${routePolicyKeyOf(modelCall)}`,
      `needsMemory=${modelCall.needsMemory || modelCall.needs_memory || modelCall.intent?.needsMemory || ''}`,
      `reason=${modelCall.needsMemoryReason || modelCall.needs_memory_reason || modelCall.recallFacet || modelCall.recall_facet || ''}`
    ].join(' '));
  }

  for (const event of traceEvents) {
    if (!rowHasExplicitRecallSignal(event)) continue;
    add('request-trace', [
      `phase=${normalizeText(event.tracePhase || event.stage)}`,
      `route=${routePolicyKeyOf(event)}`,
      `needsMemory=${event.needsMemory || event.needs_memory || event.intent?.needsMemory || ''}`,
      `reason=${event.needsMemoryReason || event.needs_memory_reason || event.recallFacet || event.recall_facet || ''}`
    ].join(' '));
  }

  for (const row of observations) {
    const plannerEnabled = normalizeArray(row.planner?.enabledBlockIds);
    const plannerSource = normalizeText(row.planner?.dynamicPromptPlanSource);
    const trace = normalizeObject(row.memoryTrace, normalizeObject(row.localMemory?.trace, {}));
    const retrievalPath = normalizeText(trace.retrieval_path);
    if (plannerEnabled.some((id) => /(?:retrieved_memory|daily_journal|memory_recall_policy)/i.test(id)) && /memory|recall|journal/i.test(plannerSource)) {
      add('memory-recall-observability.planner', `source=${plannerSource} enabled=${plannerEnabled.join(',')}`);
    }
    if (retrievalPath && retrievalPath !== 'none' && /explicit|recall|journal|lookup|memory/i.test(retrievalPath)) {
      add('memory-recall-observability.memoryTrace', `retrieval_path=${retrievalPath}`);
    }
  }

  return evidence;
}

function summarizeRequestTrace(requestId = '', events = []) {
  const latestWithRoute = events.slice().reverse().find((event) => routePolicyKeyOf(event)) || {};
  const ingress = events.find((event) => normalizeText(event.tracePhase || event.stage) === 'message_ingress') || events[0] || {};
  const plannerDone = events.find((event) => normalizeText(event.tracePhase || event.stage) === 'planner_done') || {};
  return {
    requestId,
    eventCount: events.length,
    firstRecordedAt: normalizeText(events[0]?.recordedAt),
    latestRecordedAt: normalizeText(events[events.length - 1]?.recordedAt),
    messageId: normalizeText(ingress.messageId || latestWithRoute.messageId),
    chatType: normalizeText(ingress.chatType || latestWithRoute.chatType),
    groupId: normalizeText(ingress.groupId || latestWithRoute.groupId),
    userId: normalizeText(ingress.userId || latestWithRoute.userId),
    isAdmin: events.some((event) => event.isAdmin === true),
    routePolicyKey: routePolicyKeyOf(latestWithRoute),
    routeDebugKey: routeDebugKeyOf(latestWithRoute),
    topRouteType: topRouteTypeOf(latestWithRoute),
    dispatchBranch: dispatchBranchOf(latestWithRoute),
    shouldUseTools: plannerDone.shouldUseTools === true,
    plannerMode: normalizeText(plannerDone.plannerMode),
    needsBackground: plannerDone.needsBackground === true || latestWithRoute.needsBackground === true
  };
}

function summarizeModelCall(row = {}) {
  const integrity = normalizeObject(row.prompt_integrity, {});
  const markers = normalizeObject(integrity.memory_markers, {});
  const tokenBudget = normalizeObject(integrity.token_budget, {});
  return {
    id: normalizeText(row.id),
    ts: normalizeText(row.ts || row.completed_at || row.started_at),
    status: normalizeText(row.status),
    source: normalizeText(row.source),
    model: normalizeText(row.model),
    provider: normalizeText(row.provider),
    host: normalizeText(row.host || row.api_base_url_host),
    routePolicyKey: routePolicyKeyOf(row),
    routeDebugKey: routeDebugKeyOf(row),
    topRouteType: topRouteTypeOf(row),
    dispatchBranch: dispatchBranchOf(row),
    triggerBranch: normalizeText(row.trigger_branch || row.triggerBranch),
    memoryInjected: row.memory_injected === true,
    promptIntegrity: {
      memoryMarkerCount: normalizeNumber(integrity.memory_marker_count, 0),
      memoryMarkers: {
        retrievedMemory: normalizeNumber(markers.retrieved_memory, 0),
        dailyJournal: normalizeNumber(markers.daily_journal, 0),
        shortTermContinuity: normalizeNumber(markers.short_term_continuity, 0)
      },
      hasRetrievedMemory: integrity.has_retrieved_memory === true,
      hasDailyJournal: integrity.has_daily_journal === true,
      estimatedInputTokens: normalizeNumber(tokenBudget.estimated_input_tokens, 0)
    },
    durationMs: Number.isFinite(Number(row.duration_ms)) ? Number(row.duration_ms) : null
  };
}

function buildViolation(modelCall = {}, traceEvents = [], observations = []) {
  const modelEvidence = collectBlockEvidenceFromModelCall(modelCall);
  const observationEvidence = observations.map(collectBlockEvidenceFromObservation);
  const blockIds = Array.from(new Set([
    ...modelEvidence.blocks,
    ...observationEvidence.flatMap((item) => item.blocks)
  ])).filter((blockId) => LEAK_BLOCK_IDS.includes(blockId));
  if (blockIds.length === 0) return null;

  const explicitRecallEvidence = summarizeExplicitRecallEvidence(modelCall, traceEvents, observations);
  if (explicitRecallEvidence.length > 0) return null;

  const requestId = normalizeText(modelCall.request_id || modelCall.requestId);
  return {
    requestId,
    violation: 'chat_default_memory_blocks_without_explicit_recall',
    blockIds,
    evidence: [
      ...modelEvidence.evidence,
      ...observationEvidence.flatMap((item) => item.evidence)
    ].filter((item) => blockIds.includes(item.blockId)).slice(0, 12),
    noExplicitRecallEvidence: {
      checked: true,
      sources: ['model-calls', 'request-trace', 'memory-recall-observability'],
      note: 'no needsMemory/recallFacet/lookup route evidence found for this chat/default request'
    },
    modelCall: summarizeModelCall(modelCall),
    requestTrace: summarizeRequestTrace(requestId, traceEvents),
    observationCount: observations.length
  };
}

function buildChatDefaultMemoryLeakDiagnostic(options = {}) {
  const files = resolveInputFiles(options);
  const maxLines = Math.max(100, Math.floor(normalizeNumber(options.maxLines, DEFAULT_MAX_LINES)));
  const modelRows = filterRowsByWindow(
    Array.isArray(options.modelRows) ? options.modelRows : readRecentJsonLines(files.modelCallsFile, maxLines),
    options
  );
  const traceRows = filterRowsByWindow(
    Array.isArray(options.traceRows) ? options.traceRows : readRecentJsonLines(files.requestTraceFile, maxLines),
    options
  );
  const observationRows = filterRowsByWindow(
    Array.isArray(options.observationRows) ? options.observationRows : readRecentJsonLines(files.observabilityFile, maxLines),
    options
  );
  const traceByRequest = groupTraceByRequestId(traceRows);
  const observationsByRequest = groupObservationsByRequestId(observationRows);
  const candidates = modelRows
    .filter(isOrdinaryMainReplyModelCall)
    .filter((row) => options.includeAdmin !== false || normalizeText(row.user_role || row.userRole) !== 'admin')
    .sort((a, b) => rowTimeMs(b) - rowTimeMs(a));

  const violations = [];
  for (const modelCall of candidates) {
    const requestId = normalizeText(modelCall.request_id || modelCall.requestId);
    const violation = buildViolation(
      modelCall,
      traceByRequest.get(requestId) || [],
      observationsByRequest.get(requestId) || []
    );
    if (violation) violations.push(violation);
  }

  const limit = Math.max(1, Math.floor(normalizeNumber(options.limit, DEFAULT_LIMIT)));
  const limitedViolations = violations.slice(0, limit);
  const blockCounts = {};
  for (const violation of violations) {
    for (const blockId of violation.blockIds) {
      blockCounts[blockId] = (blockCounts[blockId] || 0) + 1;
    }
  }

  return {
    schemaVersion: 'chat_default_memory_leak_diagnostic_v1',
    generatedAt: new Date().toISOString(),
    files,
    inputs: {
      maxLines,
      limit,
      sinceMs: Math.max(0, normalizeNumber(options.sinceMs, 0)),
      includeAdmin: options.includeAdmin !== false,
      rows: {
        modelCalls: modelRows.length,
        requestTrace: traceRows.length,
        observations: observationRows.length
      }
    },
    summary: {
      candidateChatDefaultRequests: candidates.length,
      violationRequests: violations.length,
      returnedViolations: limitedViolations.length,
      clean: violations.length === 0,
      blockCounts
    },
    violations: limitedViolations
  };
}

function formatChatDefaultMemoryLeakDiagnostic(report = {}) {
  const lines = [
    `chat/default memory leak diagnostic: candidates=${report.summary?.candidateChatDefaultRequests || 0} violations=${report.summary?.violationRequests || 0} returned=${report.summary?.returnedViolations || 0}`,
    `modelCalls=${report.files?.modelCallsFile || ''}`,
    `requestTrace=${report.files?.requestTraceFile || ''}`,
    `observability=${report.files?.observabilityFile || ''}`
  ];
  const blockCounts = report.summary?.blockCounts || {};
  const countText = LEAK_BLOCK_IDS
    .map((id) => `${id}=${blockCounts[id] || 0}`)
    .join(' ');
  lines.push(`summary: clean=${report.summary?.clean === true} ${countText}`);

  if (!Array.isArray(report.violations) || report.violations.length === 0) {
    lines.push('No chat/default memory block violations found in the scanned window.');
    return lines.join('\n');
  }

  for (const violation of report.violations) {
    lines.push(`- ${violation.requestId} blocks=${violation.blockIds.join(',')} model=${violation.modelCall.model} source=${violation.modelCall.source} ts=${violation.modelCall.ts}`);
    const trace = violation.requestTrace || {};
    lines.push(`  trace: messageId=${trace.messageId || 'n/a'} chat=${trace.chatType || 'n/a'} route=${trace.routePolicyKey || 'n/a'} dispatch=${trace.dispatchBranch || 'n/a'} shouldUseTools=${trace.shouldUseTools}`);
    for (const evidence of violation.evidence || []) {
      lines.push(`  evidence: ${evidence.blockId} ${evidence.source} ${evidence.detail}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  LEAK_BLOCK_IDS,
  buildChatDefaultMemoryLeakDiagnostic,
  buildViolation,
  collectBlockEvidenceFromModelCall,
  collectBlockEvidenceFromObservation,
  formatChatDefaultMemoryLeakDiagnostic,
  isOrdinaryMainReplyModelCall,
  parseArgs,
  parseDurationMs,
  readRecentJsonLines,
  rowHasExplicitRecallSignal
};

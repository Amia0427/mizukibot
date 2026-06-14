const fs = require('fs');
const path = require('path');

const config = require('../config');
const directChatPlanner = require('../core/directChatPlanner');
const { detectIntent } = require('../core/router');
const { resolveRouteExecution } = require('../core/routeExecution');
const {
  explainNormalFastReplyDecision
} = require('./normalFastReplyGate');

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data');
const DEFAULT_TRACE_FILE = path.join(DEFAULT_DATA_DIR, 'request-trace.ndjson');
const DEFAULT_MAX_LINES = 50000;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeArray(value = []) {
  return Array.isArray(value) ? value : [];
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

function parseBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = normalizeText(value).toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function splitCsv(value = '') {
  return normalizeText(value)
    .split(',')
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function parseArgs(argv = []) {
  const items = Array.isArray(argv) ? argv.slice() : [];
  const args = items[0] === 'node' || /node(?:\.exe)?$/i.test(String(items[0] || ''))
    ? items.slice(2)
    : items;
  const parsed = {
    dataDir: DEFAULT_DATA_DIR,
    traceFile: '',
    requestIds: [],
    text: '',
    userId: '',
    groupId: '',
    chatType: 'private',
    botQQ: '',
    imageUrl: '',
    allowedTools: [],
    allowTools: false,
    admin: false,
    fastReplyEnabled: config.NORMAL_FAST_REPLY_ENABLED === true,
    maxLines: DEFAULT_MAX_LINES,
    sinceMs: 0,
    limit: 20,
    json: false,
    help: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const item = normalizeText(args[i]);
    if (!item) continue;
    if (item === '--help' || item === '-h') parsed.help = true;
    else if (item === '--json') parsed.json = true;
    else if (item === '--text') {
      parsed.text = normalizeText(args[i + 1]);
      i += 1;
    } else if (item.startsWith('--text=')) {
      parsed.text = normalizeText(item.slice('--text='.length));
    } else if (item === '--request-id' || item === '--id') {
      parsed.requestIds.push(...splitCsv(args[i + 1]));
      i += 1;
    } else if (item.startsWith('--request-id=')) {
      parsed.requestIds.push(...splitCsv(item.slice('--request-id='.length)));
    } else if (item.startsWith('--id=')) {
      parsed.requestIds.push(...splitCsv(item.slice('--id='.length)));
    } else if (item === '--data-dir') {
      parsed.dataDir = normalizeText(args[i + 1]) || parsed.dataDir;
      i += 1;
    } else if (item.startsWith('--data-dir=')) {
      parsed.dataDir = normalizeText(item.slice('--data-dir='.length)) || parsed.dataDir;
    } else if (item === '--trace-file') {
      parsed.traceFile = normalizeText(args[i + 1]);
      i += 1;
    } else if (item.startsWith('--trace-file=')) {
      parsed.traceFile = normalizeText(item.slice('--trace-file='.length));
    } else if (item === '--user-id') {
      parsed.userId = normalizeText(args[i + 1]);
      i += 1;
    } else if (item.startsWith('--user-id=')) {
      parsed.userId = normalizeText(item.slice('--user-id='.length));
    } else if (item === '--group-id') {
      parsed.groupId = normalizeText(args[i + 1]);
      i += 1;
    } else if (item.startsWith('--group-id=')) {
      parsed.groupId = normalizeText(item.slice('--group-id='.length));
    } else if (item === '--chat-type') {
      parsed.chatType = normalizeText(args[i + 1]) || parsed.chatType;
      i += 1;
    } else if (item.startsWith('--chat-type=')) {
      parsed.chatType = normalizeText(item.slice('--chat-type='.length)) || parsed.chatType;
    } else if (item === '--bot-qq') {
      parsed.botQQ = normalizeText(args[i + 1]);
      i += 1;
    } else if (item.startsWith('--bot-qq=')) {
      parsed.botQQ = normalizeText(item.slice('--bot-qq='.length));
    } else if (item === '--image-url') {
      parsed.imageUrl = normalizeText(args[i + 1]);
      i += 1;
    } else if (item.startsWith('--image-url=')) {
      parsed.imageUrl = normalizeText(item.slice('--image-url='.length));
    } else if (item === '--allowed-tools') {
      parsed.allowedTools = splitCsv(args[i + 1]);
      i += 1;
    } else if (item.startsWith('--allowed-tools=')) {
      parsed.allowedTools = splitCsv(item.slice('--allowed-tools='.length));
    } else if (item === '--allow-tools') {
      parsed.allowTools = true;
    } else if (item.startsWith('--allow-tools=')) {
      parsed.allowTools = parseBool(item.slice('--allow-tools='.length), parsed.allowTools);
    } else if (item === '--admin') {
      parsed.admin = true;
    } else if (item.startsWith('--admin=')) {
      parsed.admin = parseBool(item.slice('--admin='.length), parsed.admin);
    } else if (item === '--fast-reply-enabled') {
      parsed.fastReplyEnabled = parseBool(args[i + 1], parsed.fastReplyEnabled);
      i += 1;
    } else if (item.startsWith('--fast-reply-enabled=')) {
      parsed.fastReplyEnabled = parseBool(item.slice('--fast-reply-enabled='.length), parsed.fastReplyEnabled);
    } else if (item === '--max-lines') {
      parsed.maxLines = Math.max(100, normalizeNumber(args[i + 1], parsed.maxLines));
      i += 1;
    } else if (item.startsWith('--max-lines=')) {
      parsed.maxLines = Math.max(100, normalizeNumber(item.slice('--max-lines='.length), parsed.maxLines));
    } else if (item === '--limit') {
      parsed.limit = Math.max(1, normalizeNumber(args[i + 1], parsed.limit));
      i += 1;
    } else if (item.startsWith('--limit=')) {
      parsed.limit = Math.max(1, normalizeNumber(item.slice('--limit='.length), parsed.limit));
    } else if (item === '--since' || item === '--window') {
      parsed.sinceMs = parseDurationMs(args[i + 1]);
      i += 1;
    } else if (item.startsWith('--since=')) {
      parsed.sinceMs = parseDurationMs(item.slice('--since='.length));
    } else if (item.startsWith('--window=')) {
      parsed.sinceMs = parseDurationMs(item.slice('--window='.length));
    } else if (!item.startsWith('-')) {
      parsed.requestIds.push(...splitCsv(item));
    }
  }
  parsed.traceFile = parsed.traceFile || path.join(parsed.dataDir || DEFAULT_DATA_DIR, 'request-trace.ndjson');
  parsed.requestIds = Array.from(new Set(parsed.requestIds));
  parsed.chatType = normalizeText(parsed.chatType).toLowerCase() === 'group' ? 'group' : 'private';
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

function elapsed(event = null) {
  if (!event || event.elapsedSinceRequestStartMs === null || event.elapsedSinceRequestStartMs === undefined) return null;
  const n = Number(event.elapsedSinceRequestStartMs);
  return Number.isFinite(n) ? n : null;
}

function duration(event = null) {
  if (!event || event.durationMs === null || event.durationMs === undefined) return null;
  const n = Number(event.durationMs);
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

function sortEvents(events = []) {
  return events.slice().sort((a, b) => {
    const seqA = Number(a.phaseSeq || 0);
    const seqB = Number(b.phaseSeq || 0);
    if (seqA || seqB) return seqA - seqB;
    return eventMs(a) - eventMs(b);
  });
}

function eventStage(event = {}) {
  return normalizeText(event.stage || event.tracePhase || event.type);
}

function firstBy(events = [], predicate = null) {
  if (typeof predicate !== 'function') return null;
  return events.find(predicate) || null;
}

function lastBy(events = [], predicate = null) {
  if (typeof predicate !== 'function') return null;
  return events.slice().reverse().find(predicate) || null;
}

function summarizeFastReplyFromEvents(events = []) {
  const attempted = events.some((event) => eventStage(event).startsWith('normal_fast_reply_'));
  const skipped = firstBy(events, (event) => eventStage(event) === 'normal_fast_reply_skipped');
  const rateLimited = firstBy(events, (event) => eventStage(event) === 'normal_fast_reply_rate_limited');
  const stale = firstBy(events, (event) => eventStage(event) === 'normal_fast_reply_stale');
  const failed = firstBy(events, (event) => eventStage(event) === 'normal_fast_reply_failed');
  const sendDone = firstBy(events, (event) => eventStage(event) === 'normal_fast_reply_send_done');
  const succeeded = Boolean(sendDone && sendDone.sent === true && !failed && !stale && !rateLimited);
  const reason = normalizeText(skipped?.reason)
    || normalizeText(failed?.finalErrorCode)
    || normalizeText(failed?.error)
    || normalizeText(rateLimited?.finalErrorCode)
    || normalizeText(stale?.stage)
    || (succeeded ? 'sent' : (attempted ? 'attempted' : 'not_attempted'));
  return {
    attempted,
    succeeded,
    skipped: Boolean(skipped),
    reason,
    failed: Boolean(failed),
    rateLimited: Boolean(rateLimited),
    stale: Boolean(stale),
    durationMs: duration(sendDone) ?? duration(failed) ?? duration(rateLimited) ?? duration(stale),
    events: events
      .filter((event) => eventStage(event).startsWith('normal_fast_reply_'))
      .map((event) => ({
        stage: eventStage(event),
        elapsedMs: elapsed(event),
        durationMs: duration(event),
        reason: normalizeText(event.reason || event.finalErrorCode || event.error)
      }))
  };
}

function summarizePlannerFromEvents(events = []) {
  const start = firstBy(events, (event) => eventStage(event) === 'direct_chat_planner_start' || event.tracePhase === 'planner_start');
  const done = firstBy(events, (event) => eventStage(event) === 'direct_chat_planner_done' || event.tracePhase === 'planner_done');
  const failed = firstBy(events, (event) => eventStage(event) === 'direct_chat_planner_failed' || event.tracePhase === 'planner_failed');
  return {
    entered: Boolean(start || done || failed),
    failed: Boolean(failed),
    decisionSource: normalizeText(done?.decisionSource || done?.plannerDecisionSource),
    shouldUseTools: done?.shouldUseTools === true,
    needsBackground: done?.needsBackground === true,
    allowedToolCount: Number(done?.allowedToolCount || 0) || 0,
    plannerFallbackUsed: done?.plannerFallbackUsed === true,
    plannerModel: normalizeText(done?.plannerModel),
    durationMs: duration(done) ?? duration(failed) ?? deltaBetween(start, done || failed)
  };
}

function summarizeRouteExecutionFromEvents(events = []) {
  const routeExecution = lastBy(events, (event) => eventStage(event) === 'route_execution_done' || eventStage(event) === 'route_execution_failed');
  const dispatch = lastBy(events, (event) => eventStage(event) === 'dispatch_branch_selected');
  const unavailable = lastBy(events, (event) => eventStage(event) === 'dispatch_unavailable');
  const complete = lastBy(events, (event) => eventStage(event) === 'request_complete');
  const finalSend = lastBy(events, (event) => eventStage(event) === 'final_reply_send_done');
  const fastComplete = complete && normalizeText(complete.replyPath) === 'normal_fast_reply';
  const dispatchBranch = fastComplete
    ? 'normal_fast_reply'
    : normalizeText(dispatch?.dispatchBranch || finalSend?.replyPath || unavailable?.dispatchBranch);
  return {
    routePolicyKey: normalizeText(routeExecution?.routePolicyKey || dispatch?.routePolicyKey || finalSend?.routePolicyKey || complete?.routePolicyKey),
    routeDebugKey: normalizeText(routeExecution?.routeDebugKey || dispatch?.routeDebugKey || finalSend?.routeDebugKey),
    topRouteType: normalizeText(routeExecution?.topRouteType || dispatch?.topRouteType || finalSend?.topRouteType || complete?.topRouteType),
    executor: normalizeText(routeExecution?.executor || dispatch?.executor),
    plannerMode: normalizeText(routeExecution?.plannerMode || dispatch?.plannerMode),
    plannerStepCount: Number(routeExecution?.plannerStepCount ?? dispatch?.plannerStepCount ?? 0) || 0,
    plannerTools: normalizeArray(routeExecution?.plannerTools || dispatch?.plannerTools).map(normalizeText).filter(Boolean),
    shouldUseTools: routeExecution?.shouldUseTools === true || dispatch?.shouldUseTools === true,
    allowTools: dispatch?.allowTools === true || routeExecution?.allowTools === true,
    allowedToolNames: normalizeArray(routeExecution?.allowedToolNames || dispatch?.allowedToolNames).map(normalizeText).filter(Boolean),
    needsBackground: routeExecution?.needsBackground === true || dispatch?.needsBackground === true,
    unavailableReason: normalizeText(
      routeExecution?.unavailableReason
      || dispatch?.unavailableReason
      || unavailable?.unavailableReason
      || unavailable?.fallbackReason
    ),
    dispatchBranch,
    finalReplyPath: normalizeText(complete?.replyPath || finalSend?.replyPath || dispatchBranch),
    sent: complete?.sent === true || finalSend?.sent === true,
    durationMs: duration(routeExecution)
  };
}

function summarizeRuntimeFromEvents(events = []) {
  const dispatchSelected = lastBy(events, (event) => eventStage(event) === 'dispatch_branch_selected');
  const fastComplete = lastBy(events, (event) => eventStage(event) === 'request_complete' && normalizeText(event.replyPath) === 'normal_fast_reply');
  if (fastComplete) {
    return {
      node: 'normal_fast_reply',
      branch: 'normal_fast_reply',
      prepareFastPath: '',
      reason: 'fast reply sent before formal runtime'
    };
  }
  const nodeStarts = events
    .filter((event) => eventStage(event) === 'node_start' && normalizeText(event.node))
    .map((event) => normalizeText(event.node));
  const prepareLatency = lastBy(events, (event) => eventStage(event) === 'latency_profile' && normalizeText(event.node) === 'prepare');
  const branch = normalizeText(dispatchSelected?.dispatchBranch);
  return {
    node: nodeStarts[0] || (branch ? 'route_dispatch' : ''),
    nodes: Array.from(new Set(nodeStarts)),
    branch,
    prepareFastPath: normalizeText(prepareLatency?.fastPath),
    reason: ''
  };
}

function summarizeDurations(events = []) {
  const ingress = firstBy(events, (event) => eventStage(event) === 'handle_incoming_start' || event.tracePhase === 'message_ingress');
  const fastSend = firstBy(events, (event) => eventStage(event) === 'normal_fast_reply_send_done');
  const plannerStart = firstBy(events, (event) => eventStage(event) === 'direct_chat_planner_start' || event.tracePhase === 'planner_start');
  const plannerDone = firstBy(events, (event) => eventStage(event) === 'direct_chat_planner_done' || event.tracePhase === 'planner_done');
  const routeExecution = lastBy(events, (event) => eventStage(event) === 'route_execution_done');
  const runtimeDispatchStart = firstBy(events, (event) => eventStage(event) === 'formal_route_dispatch_start' || event.tracePhase === 'runtime_dispatch_start');
  const runtimeDispatchDone = firstBy(events, (event) => eventStage(event) === 'formal_route_dispatch_done' || event.tracePhase === 'runtime_dispatch_done');
  const prepareStart = firstBy(events, (event) => eventStage(event) === 'node_start' && normalizeText(event.node) === 'prepare');
  const prepareDone = firstBy(events, (event) => eventStage(event) === 'node_complete' && normalizeText(event.node) === 'prepare');
  const routeStart = firstBy(events, (event) => eventStage(event) === 'node_start' && normalizeText(event.node) === 'route');
  const routeDone = firstBy(events, (event) => eventStage(event) === 'node_complete' && normalizeText(event.node) === 'route');
  const httpStart = firstBy(events, (event) => eventStage(event) === 'http_client_start');
  const httpSuccess = firstBy(events, (event) => eventStage(event) === 'http_client_success');
  const complete = lastBy(events, (event) => eventStage(event) === 'request_complete');
  return {
    normalFastReplyMs: duration(fastSend),
    plannerMs: duration(plannerDone) ?? deltaBetween(plannerStart, plannerDone),
    routeExecutionMs: duration(routeExecution),
    formalDispatchMs: duration(runtimeDispatchDone) ?? deltaBetween(runtimeDispatchStart, runtimeDispatchDone),
    prepareMs: deltaBetween(prepareStart, prepareDone),
    routeNodeMs: deltaBetween(routeStart, routeDone),
    upstreamMs: duration(httpSuccess) ?? deltaBetween(httpStart, httpSuccess),
    totalMs: duration(complete) ?? deltaBetween(ingress, complete)
  };
}

function inferRouteKind({ fastReply = {}, planner = {}, routeExecution = {} } = {}) {
  if (fastReply.succeeded) return 'normal_fast_reply';
  if (routeExecution.unavailableReason && routeExecution.dispatchBranch === 'direct_reply') return 'degraded_direct_reply';
  if (routeExecution.dispatchBranch === 'tool_plan' || routeExecution.allowTools) return 'planner_tool_route';
  if (routeExecution.dispatchBranch === 'background_direct' || routeExecution.needsBackground) return 'planner_background';
  if (routeExecution.dispatchBranch === 'direct_reply') return 'direct_reply';
  if (planner.entered) return planner.shouldUseTools ? 'planner_tool_route' : 'direct_reply';
  return routeExecution.routePolicyKey || 'unknown';
}

function explainFastReplySkipReason(reason = '') {
  const normalized = normalizeText(reason);
  const map = {
    disabled: { key: 'enabled', label: 'NORMAL_FAST_REPLY_ENABLED=true', exitFlag: 'permission' },
    missing_user_id: { key: 'has_user_id', label: 'user id present', exitFlag: 'permission' },
    admin_user: { key: 'normal_user', label: 'not admin user', exitFlag: 'permission' },
    not_direct_chat: { key: 'direct_chat_route', label: 'top route is direct_chat', exitFlag: 'route' },
    non_direct_executor: { key: 'direct_executor', label: 'executor is direct', exitFlag: 'route' },
    route_unavailable: { key: 'route_available', label: 'route execution is available', exitFlag: 'route' },
    tools_allowed: { key: 'tools_not_allowed', label: 'route does not allow tools', exitFlag: 'tools' },
    tools_present: { key: 'no_tools_present', label: 'no planner/tool allowlist present', exitFlag: 'tools' },
    image_present: { key: 'no_image_input', label: 'no image or visual input', exitFlag: 'image' },
    route_action_or_safety: { key: 'no_route_action_or_safety', label: 'no action/safety route metadata', exitFlag: 'permission' },
    memory_cli_turn: { key: 'no_memory_cli_turn', label: 'no memory_cli turn state', exitFlag: 'continuity' },
    empty_text: { key: 'text_present', label: 'text is not empty', exitFlag: 'continuity' },
    slash_command: { key: 'not_slash_command', label: 'not a slash command', exitFlag: 'permission' },
    admin_like_command: { key: 'not_admin_like_command', label: 'not admin-like command text', exitFlag: 'permission' },
    memory_recall_like: { key: 'no_memory_recall_request', label: 'no memory/continuity recall request', exitFlag: 'continuity' },
    search_or_freshness_like: { key: 'no_search_or_freshness_request', label: 'no search/freshness request', exitFlag: 'tools' },
    complex_task_like: { key: 'not_complex_task', label: 'not a complex/planning task', exitFlag: 'continuity' }
  };
  return map[normalized] || null;
}

function summarizeFastReplyConditionsFromTrace(fastReply = {}) {
  if (fastReply.succeeded) {
    return {
      matched: [{ key: 'sent', label: 'normal_fast_reply send succeeded', ok: true }],
      missed: [],
      exitFlags: { tools: false, image: false, permission: false, continuity: false, route: false }
    };
  }
  const missed = [];
  const mapped = explainFastReplySkipReason(fastReply.reason);
  if (mapped) missed.push({ ...mapped, ok: false, reason: fastReply.reason });
  else if (fastReply.failed) missed.push({ key: 'runtime_failed', label: 'fast reply runtime failed', ok: false, reason: fastReply.reason, exitFlag: 'route' });
  else if (fastReply.rateLimited) missed.push({ key: 'rate_limited', label: 'fast reply rate limited', ok: false, reason: fastReply.reason, exitFlag: 'permission' });
  else if (fastReply.stale) missed.push({ key: 'stale', label: 'fast reply became stale', ok: false, reason: fastReply.reason, exitFlag: 'continuity' });
  const flags = {
    tools: missed.some((item) => item.exitFlag === 'tools'),
    image: missed.some((item) => item.exitFlag === 'image'),
    permission: missed.some((item) => item.exitFlag === 'permission'),
    continuity: missed.some((item) => item.exitFlag === 'continuity'),
    route: missed.some((item) => item.exitFlag === 'route')
  };
  return {
    matched: fastReply.attempted ? [{ key: 'attempted', label: 'normal fast reply gate passed far enough to attempt runtime', ok: true }] : [],
    missed,
    exitFlags: flags
  };
}

function summarizeRequestFromEvents(requestId = '', events = []) {
  const sorted = sortEvents(events);
  const ingress = firstBy(sorted, (event) => eventStage(event) === 'handle_incoming_start' || event.tracePhase === 'message_ingress');
  const fastReply = summarizeFastReplyFromEvents(sorted);
  const planner = summarizePlannerFromEvents(sorted);
  const routeExecution = summarizeRouteExecutionFromEvents(sorted);
  const runtime = summarizeRuntimeFromEvents(sorted);
  const durations = summarizeDurations(sorted);
  const fastConditions = summarizeFastReplyConditionsFromTrace(fastReply);
  return {
    inputMode: 'request_id',
    requestId,
    recordedAt: normalizeText(ingress?.recordedAt || sorted[0]?.recordedAt),
    messageId: normalizeText(ingress?.messageId || sorted.find((event) => event.messageId)?.messageId),
    userId: normalizeText(ingress?.userId || sorted.find((event) => event.userId)?.userId),
    groupId: normalizeText(ingress?.groupId || sorted.find((event) => event.groupId)?.groupId),
    chatType: normalizeText(ingress?.chatType || sorted.find((event) => event.chatType)?.chatType),
    route: {
      kind: inferRouteKind({ fastReply, planner, routeExecution }),
      policyKey: routeExecution.routePolicyKey,
      debugKey: routeExecution.routeDebugKey,
      topRouteType: routeExecution.topRouteType,
      executor: routeExecution.executor,
      dispatchBranch: routeExecution.dispatchBranch,
      unavailableReason: routeExecution.unavailableReason
    },
    fastReply: {
      ...fastReply,
      matchedConditions: fastConditions.matched,
      missedConditions: fastConditions.missed,
      exitFlags: fastConditions.exitFlags
    },
    planner,
    routeExecution,
    runtime,
    durations
  };
}

function buildRouteFromTestInput(options = {}) {
  const rawText = normalizeText(options.text);
  const route = detectIntent({
    rawText,
    botQQ: normalizeText(options.botQQ),
    userId: normalizeText(options.userId),
    chatType: normalizeText(options.chatType),
    effectiveIntentText: rawText
  });
  if (normalizeText(options.imageUrl)) {
    route.imageUrl = normalizeText(options.imageUrl);
    route.meta = {
      ...(route.meta || {}),
      chatMode: route.meta?.chatMode === 'image_summary' ? 'image_summary' : 'image_qa'
    };
  }
  if (normalizeArray(options.allowedTools).length > 0) {
    route.meta = {
      ...(route.meta || {}),
      allowedTools: normalizeArray(options.allowedTools)
    };
  }
  return route;
}

function summarizeTestInput(options = {}) {
  const route = buildRouteFromTestInput(options);
  const normalFastRoutePlan = {
    executor: 'direct',
    topRouteType: 'direct_chat',
    policyKey: 'chat/default',
    routeDebugKey: 'direct_chat/text_chat/answer',
    allowTools: false,
    allowedTools: [],
    allowedToolBuckets: [],
    allowStream: false,
    needsBackground: false,
    unavailableReason: ''
  };
  const runtimeConfig = {
    ...config,
    NORMAL_FAST_REPLY_ENABLED: options.fastReplyEnabled === true
  };
  const userId = normalizeText(options.userId) || (options.admin ? 'admin_diag' : 'diag_user');
  const fastExplanation = explainNormalFastReplyDecision({
    userId,
    cleanText: normalizeText(options.text),
    rawText: normalizeText(options.text),
    route,
    routeExecutionPlan: normalFastRoutePlan,
    allowedTools: normalizeArray(options.allowedTools),
    imageUrl: normalizeText(options.imageUrl)
  }, runtimeConfig, {
    isAdminUser: () => options.admin === true
  });

  let plannerDecision = null;
  if (route.topRouteType === 'direct_chat' && !fastExplanation.eligible) {
    const ruleDecision = directChatPlanner.buildRuleBasedPlan(route, {
      userId,
      allowedTools: normalizeArray(options.allowedTools),
      fallbackUsed: false,
      decisionSource: 'diagnostic_rule_planner'
    });
    plannerDecision = directChatPlanner.normalizePlannerOutput(ruleDecision, route, {
      userId,
      allowedTools: normalizeArray(options.allowedTools)
    });
    route.meta = {
      ...(route.meta || {}),
      toolPlanner: plannerDecision,
      directChatPlanner: plannerDecision
    };
  }

  const routeExecutionPlan = resolveRouteExecution(route, config, {});
  const allowTools = options.allowTools === true || routeExecutionPlan.allowTools === true;
  const routeKind = fastExplanation.eligible
    ? 'normal_fast_reply'
    : (allowTools
      ? 'planner_tool_route'
      : (normalizeText(routeExecutionPlan.unavailableReason) ? 'degraded_direct_reply' : 'direct_reply'));
  return {
    inputMode: 'test_input',
    requestId: '',
    text: normalizeText(options.text),
    userId,
    chatType: normalizeText(options.chatType),
    route: {
      kind: routeKind,
      policyKey: routeExecutionPlan.policyKey,
      debugKey: routeExecutionPlan.routeDebugKey,
      topRouteType: routeExecutionPlan.topRouteType,
      executor: routeExecutionPlan.executor,
      dispatchBranch: routeKind === 'normal_fast_reply' ? 'normal_fast_reply' : (allowTools ? 'tool_plan' : 'direct_reply'),
      unavailableReason: normalizeText(routeExecutionPlan.unavailableReason),
      localRuleId: normalizeText(route.meta?.localRuleId),
      routeReason: normalizeText(route.meta?.reason)
    },
    fastReply: {
      attempted: fastExplanation.eligible,
      succeeded: false,
      skipped: !fastExplanation.eligible,
      reason: fastExplanation.reason,
      matchedConditions: fastExplanation.matchedConditions,
      missedConditions: fastExplanation.missedConditions,
      exitFlags: fastExplanation.exitFlags
    },
    planner: {
      entered: route.topRouteType === 'direct_chat' && !fastExplanation.eligible,
      failed: false,
      decisionSource: normalizeText(plannerDecision?.decisionSource),
      shouldUseTools: plannerDecision?.shouldUseTools === true,
      needsBackground: routeExecutionPlan.needsBackground === true,
      allowedToolCount: normalizeArray(plannerDecision?.allowedToolNames).length,
      plannerFallbackUsed: plannerDecision?.plannerFallbackUsed === true,
      plannerModel: normalizeText(plannerDecision?.plannerModel),
      durationMs: null
    },
    routeExecution: {
      routePolicyKey: routeExecutionPlan.policyKey,
      routeDebugKey: routeExecutionPlan.routeDebugKey,
      topRouteType: routeExecutionPlan.topRouteType,
      executor: routeExecutionPlan.executor,
      shouldUseTools: routeExecutionPlan.allowTools === true,
      allowTools: routeExecutionPlan.allowTools === true,
      allowedToolNames: normalizeArray(routeExecutionPlan.allowedTools),
      needsBackground: routeExecutionPlan.needsBackground === true,
      unavailableReason: normalizeText(routeExecutionPlan.unavailableReason),
      dispatchBranch: routeKind === 'normal_fast_reply' ? 'normal_fast_reply' : (allowTools ? 'tool_plan' : 'direct_reply'),
      durationMs: null
    },
    runtime: {
      node: routeKind === 'normal_fast_reply' ? 'normal_fast_reply' : 'prepare',
      nodes: routeKind === 'normal_fast_reply' ? [] : ['prepare', 'route', routeExecutionPlan.allowTools ? 'planner/dispatch' : 'direct_reply'],
      branch: routeKind === 'normal_fast_reply' ? 'normal_fast_reply' : (allowTools ? 'tool_plan' : 'direct_reply'),
      prepareFastPath: '',
      reason: 'test input prediction; no runtime was executed'
    },
    durations: {
      normalFastReplyMs: null,
      plannerMs: null,
      routeExecutionMs: null,
      formalDispatchMs: null,
      prepareMs: null,
      routeNodeMs: null,
      upstreamMs: null,
      totalMs: null
    }
  };
}

function buildRouteDecisionDiagnostic(options = {}) {
  const requests = [];
  const traceFile = normalizeText(options.traceFile || DEFAULT_TRACE_FILE);
  if (normalizeText(options.text)) {
    requests.push(summarizeTestInput(options));
  } else {
    const rows = Array.isArray(options.rows)
      ? options.rows
      : readRecentJsonLines(traceFile, options.maxLines || DEFAULT_MAX_LINES);
    const wanted = new Set(normalizeArray(options.requestIds).map(normalizeText).filter(Boolean));
    const untilMs = Number(options.nowMs || Date.now());
    const sinceMs = Number(options.sinceMs || 0) > 0 ? untilMs - Number(options.sinceMs) : 0;
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
    const summaries = Array.from(grouped.entries())
      .map(([requestId, events]) => summarizeRequestFromEvents(requestId, events))
      .sort((a, b) => (Date.parse(b.recordedAt || '') || 0) - (Date.parse(a.recordedAt || '') || 0))
      .slice(0, Math.max(1, Number(options.limit || 20) || 20));
    requests.push(...summaries);
  }

  return {
    schemaVersion: 'route_decision_diagnostic_v1',
    generatedAt: new Date().toISOString(),
    traceFile,
    readOnly: true,
    inputs: {
      mode: normalizeText(options.text) ? 'test_input' : 'request_id',
      requestIds: normalizeArray(options.requestIds).map(normalizeText).filter(Boolean),
      hasText: Boolean(normalizeText(options.text)),
      maxLines: Math.max(1, Number(options.maxLines || DEFAULT_MAX_LINES) || DEFAULT_MAX_LINES),
      limit: Math.max(1, Number(options.limit || 20) || 20)
    },
    requests
  };
}

function formatMs(value) {
  if (value === null || value === undefined || value === '') return 'n/a';
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}ms` : 'n/a';
}

function formatConditionList(items = []) {
  const normalized = normalizeArray(items);
  if (normalized.length === 0) return 'none';
  return normalized
    .map((item) => `${item.key}${item.reason ? `(${item.reason})` : ''}`)
    .join(',');
}

function formatExitFlags(flags = {}) {
  return ['tools', 'image', 'permission', 'continuity', 'route']
    .map((key) => `${key}=${flags?.[key] === true ? 'yes' : 'no'}`)
    .join(' ');
}

function formatRouteDecisionDiagnostic(report = {}) {
  const lines = [
    `route-decision: requests=${report.requests?.length || 0} mode=${report.inputs?.mode || 'unknown'} readOnly=${report.readOnly === true}`
  ];
  if (normalizeText(report.traceFile)) lines[0] += ` trace=${report.traceFile}`;
  for (const request of report.requests || []) {
    lines.push([
      `- ${request.requestId || 'test-input'}`,
      `route=${request.route?.kind || 'unknown'}`,
      `policy=${request.route?.policyKey || 'unknown'}`,
      `branch=${request.route?.dispatchBranch || request.runtime?.branch || 'unknown'}`,
      `runtime=${request.runtime?.node || 'unknown'}`
    ].join(' '));
    lines.push([
      '  fast-reply:',
      `reason=${request.fastReply?.reason || 'none'}`,
      `attempted=${request.fastReply?.attempted === true}`,
      `succeeded=${request.fastReply?.succeeded === true}`,
      `matched=${formatConditionList(request.fastReply?.matchedConditions)}`,
      `missed=${formatConditionList(request.fastReply?.missedConditions)}`
    ].join(' '));
    lines.push(`  exits: ${formatExitFlags(request.fastReply?.exitFlags)}`);
    lines.push([
      '  planner:',
      `entered=${request.planner?.entered === true}`,
      `source=${request.planner?.decisionSource || 'none'}`,
      `tools=${request.planner?.shouldUseTools === true}`,
      `allowed=${Number(request.planner?.allowedToolCount || 0) || 0}`,
      `fallback=${request.planner?.plannerFallbackUsed === true}`,
      `ms=${formatMs(request.planner?.durationMs)}`
    ].join(' '));
    lines.push([
      '  runtime:',
      `node=${request.runtime?.node || 'unknown'}`,
      `nodes=${normalizeArray(request.runtime?.nodes).join('>') || 'none'}`,
      `prepareFastPath=${request.runtime?.prepareFastPath || 'none'}`,
      `unavailable=${request.route?.unavailableReason || 'none'}`
    ].join(' '));
    lines.push([
      '  durations:',
      `fast=${formatMs(request.durations?.normalFastReplyMs)}`,
      `planner=${formatMs(request.durations?.plannerMs)}`,
      `routeExec=${formatMs(request.durations?.routeExecutionMs)}`,
      `prepare=${formatMs(request.durations?.prepareMs)}`,
      `routeNode=${formatMs(request.durations?.routeNodeMs)}`,
      `upstream=${formatMs(request.durations?.upstreamMs)}`,
      `total=${formatMs(request.durations?.totalMs)}`
    ].join(' '));
  }
  return lines.join('\n');
}

module.exports = {
  buildRouteDecisionDiagnostic,
  formatRouteDecisionDiagnostic,
  parseArgs,
  parseDurationMs,
  readRecentJsonLines,
  summarizeRequestFromEvents,
  summarizeTestInput
};

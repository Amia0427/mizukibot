const assert = require('assert');

process.env.NORMAL_FAST_REPLY_ENABLED = 'true';

const {
  buildRouteDecisionDiagnostic,
  formatRouteDecisionDiagnostic,
  parseArgs,
  summarizeTestInput
} = require('../utils/routeDecisionDiagnostics');

function ev(requestId, phaseSeq, tracePhase, elapsedMs, extra = {}) {
  return {
    recordedAt: new Date(Date.parse('2026-06-14T01:00:00.000Z') + elapsedMs).toISOString(),
    requestId,
    phaseSeq,
    tracePhase,
    stage: extra.stage || tracePhase,
    requestStartedAt: Date.parse('2026-06-14T01:00:00.000Z'),
    elapsedSinceRequestStartMs: elapsedMs,
    ...extra
  };
}

const fastRequestId = 'req_route_diag_fast';
const directRequestId = 'req_route_diag_direct';
const rows = [
  ev(fastRequestId, 1, 'message_ingress', 0, {
    stage: 'handle_incoming_start',
    userId: 'u1',
    chatType: 'private',
    messageId: 'm1'
  }),
  ev(fastRequestId, 2, 'normal_fast_reply_send_start', 30, {
    stage: 'normal_fast_reply_send_start',
    replyChars: 8
  }),
  ev(fastRequestId, 3, 'normal_fast_reply_send_done', 140, {
    stage: 'normal_fast_reply_send_done',
    sent: true,
    durationMs: 110
  }),
  ev(fastRequestId, 4, 'request_complete', 145, {
    stage: 'request_complete',
    routePolicyKey: 'chat/default',
    topRouteType: 'direct_chat',
    replyPath: 'normal_fast_reply',
    sent: true,
    durationMs: 145
  }),

  ev(directRequestId, 1, 'message_ingress', 0, {
    stage: 'handle_incoming_start',
    userId: 'u2',
    chatType: 'private',
    messageId: 'm2'
  }),
  ev(directRequestId, 2, 'normal_fast_reply_skipped', 8, {
    stage: 'normal_fast_reply_skipped',
    reason: 'memory_recall_like'
  }),
  ev(directRequestId, 3, 'planner_start', 10, {
    stage: 'direct_chat_planner_start'
  }),
  ev(directRequestId, 4, 'planner_done', 60, {
    stage: 'direct_chat_planner_done',
    durationMs: 50,
    shouldUseTools: false,
    allowedToolCount: 0,
    plannerFallbackUsed: true
  }),
  ev(directRequestId, 5, 'route_execution_done', 62, {
    stage: 'route_execution_done',
    routePolicyKey: 'chat/default',
    routeDebugKey: 'direct_chat/text_chat/answer',
    topRouteType: 'direct_chat',
    executor: 'direct',
    shouldUseTools: false,
    plannerMode: 'chat_only',
    allowedToolNames: []
  }),
  ev(directRequestId, 6, 'runtime_dispatch_start', 70, {
    stage: 'formal_route_dispatch_start'
  }),
  ev(directRequestId, 7, 'dispatch_branch_selected', 72, {
    stage: 'dispatch_branch_selected',
    dispatchBranch: 'direct_reply',
    routePolicyKey: 'chat/default',
    routeDebugKey: 'direct_chat/text_chat/answer',
    topRouteType: 'direct_chat',
    executor: 'direct',
    allowTools: false
  }),
  ev(directRequestId, 8, 'runtime_v2_node_start', 80, {
    stage: 'node_start',
    node: 'prepare'
  }),
  ev(directRequestId, 9, 'runtime_v2_latency_profile', 81, {
    stage: 'latency_profile',
    node: 'prepare',
    fastPath: 'plain_private_chat'
  }),
  ev(directRequestId, 10, 'runtime_v2_node_complete', 90, {
    stage: 'node_complete',
    node: 'prepare'
  }),
  ev(directRequestId, 11, 'http_client_start', 100, {
    stage: 'http_client_start',
    source: 'v2_streaming_reply'
  }),
  ev(directRequestId, 12, 'http_client_success', 600, {
    stage: 'http_client_success',
    source: 'v2_streaming_reply',
    durationMs: 500
  }),
  ev(directRequestId, 13, 'request_complete', 650, {
    stage: 'request_complete',
    routePolicyKey: 'chat/default',
    topRouteType: 'direct_chat',
    sent: true,
    durationMs: 650
  })
];

const report = buildRouteDecisionDiagnostic({
  rows,
  requestIds: [fastRequestId, directRequestId],
  limit: 5
});

assert.strictEqual(report.schemaVersion, 'route_decision_diagnostic_v1');
assert.strictEqual(report.readOnly, true);
assert.strictEqual(report.requests.length, 2);

const fast = report.requests.find((item) => item.requestId === fastRequestId);
assert.strictEqual(fast.route.kind, 'normal_fast_reply');
assert.strictEqual(fast.runtime.node, 'normal_fast_reply');
assert.strictEqual(fast.fastReply.succeeded, true);
assert.strictEqual(fast.durations.normalFastReplyMs, 110);

const direct = report.requests.find((item) => item.requestId === directRequestId);
assert.strictEqual(direct.route.kind, 'direct_reply');
assert.strictEqual(direct.fastReply.reason, 'memory_recall_like');
assert.strictEqual(direct.fastReply.exitFlags.continuity, true);
assert.strictEqual(direct.planner.entered, true);
assert.strictEqual(direct.planner.plannerFallbackUsed, true);
assert.strictEqual(direct.runtime.node, 'prepare');
assert.strictEqual(direct.runtime.prepareFastPath, 'plain_private_chat');
assert.strictEqual(direct.durations.upstreamMs, 500);

const text = formatRouteDecisionDiagnostic(report);
assert.ok(text.includes('route=normal_fast_reply'));
assert.ok(text.includes('missed=no_memory_recall_request(memory_recall_like)'));

const parsed = parseArgs(['node', 'script', '--request-id', 'a,b', '--since=2h', '--json']);
assert.deepStrictEqual(parsed.requestIds, ['a', 'b']);
assert.strictEqual(parsed.sinceMs, 2 * 60 * 60 * 1000);
assert.strictEqual(parsed.json, true);

const plainPrediction = summarizeTestInput({
  text: '今晚吃什么好',
  userId: 'normal_1',
  chatType: 'private',
  fastReplyEnabled: true
});
assert.strictEqual(plainPrediction.route.kind, 'normal_fast_reply');
assert.strictEqual(plainPrediction.fastReply.reason, 'eligible');
assert.strictEqual(plainPrediction.fastReply.missedConditions.length, 0);

const searchPrediction = summarizeTestInput({
  text: '搜索一下今天新闻',
  userId: 'normal_1',
  chatType: 'private',
  fastReplyEnabled: true
});
assert.strictEqual(searchPrediction.route.kind, 'direct_reply');
assert.strictEqual(searchPrediction.fastReply.reason, 'search_or_freshness_like');
assert.strictEqual(searchPrediction.fastReply.exitFlags.tools, true);

const imagePrediction = summarizeTestInput({
  text: '看看这张图',
  userId: 'normal_1',
  chatType: 'private',
  imageUrl: 'https://example.com/a.png',
  fastReplyEnabled: true
});
assert.strictEqual(imagePrediction.fastReply.reason, 'image_present');
assert.strictEqual(imagePrediction.fastReply.exitFlags.image, true);

console.log('routeDecisionDiagnostics.test.js passed');

const assert = require('assert');

const {
  buildRequestTracePreflightDiagnostic,
  formatRequestTracePreflightDiagnostic,
  parseArgs,
  parseDurationMs
} = require('../utils/requestTracePreflightDiagnostics');

function ev(requestId, phaseSeq, tracePhase, elapsedMs, extra = {}) {
  return {
    recordedAt: new Date(Date.parse('2026-06-08T22:56:46.000Z') + elapsedMs).toISOString(),
    requestId,
    phaseSeq,
    tracePhase,
    stage: extra.stage || tracePhase,
    requestStartedAt: Date.parse('2026-06-08T22:56:46.000Z'),
    elapsedSinceRequestStartMs: elapsedMs,
    ...extra
  };
}

module.exports = (() => {
  const requestId = 'req_diag_plain_chat';
  const rows = [
    ev(requestId, 1, 'message_ingress', 0, {
      stage: 'handle_incoming_start',
      messageId: 'm1',
      userId: 'u1',
      chatType: 'private'
    }),
    ev(requestId, 2, 'message_ingress_lock_acquired', 15000, { stage: 'inbound_lock_acquired' }),
    ev(requestId, 3, 'message_ingress_route_entry', 15002, { stage: 'inbound_route_entry' }),
    ev(requestId, 4, 'router_start', 18000, { stage: 'route_resolver_start' }),
    ev(requestId, 5, 'planner_start', 18010, { stage: 'direct_chat_planner_start' }),
    ev(requestId, 6, 'planner_done', 34010, {
      stage: 'direct_chat_planner_done',
      durationMs: 16000,
      shouldUseTools: false,
      allowedToolCount: 0
    }),
    ev(requestId, 7, 'runtime_dispatch_start', 34020, { stage: 'formal_route_dispatch_start' }),
    ev(requestId, 8, 'dispatch_branch_selected', 34030, {
      stage: 'dispatch_branch_selected',
      source: 'route_dispatch',
      routePolicyKey: 'chat/default',
      routeDebugKey: 'direct_chat/text_chat/answer',
      allowTools: false
    }),
    ev(requestId, 9, 'runtime_v2_node_start', 37000, {
      stage: 'node_start',
      node: 'prepare'
    }),
    ev(requestId, 10, 'runtime_v2_latency_profile', 37001, {
      stage: 'latency_profile',
      node: 'prepare',
      fastPath: 'plain_private_chat'
    }),
    ev(requestId, 11, 'runtime_v2_node_complete', 37005, {
      stage: 'node_complete',
      node: 'prepare'
    }),
    ev(requestId, 12, 'runtime_v2_node_complete', 37020, {
      stage: 'node_complete',
      node: 'route'
    }),
    ev(requestId, 13, 'http_client_start', 37500, {
      stage: 'http_client_start',
      source: 'v2_streaming_reply'
    }),
    ev(requestId, 14, 'http_client_success', 87500, {
      stage: 'http_client_success',
      source: 'v2_streaming_reply',
      durationMs: 50000
    }),
    ev(requestId, 15, 'final_reply_send_done', 88000, {
      stage: 'final_reply_send_done',
      durationMs: 54000
    }),
    ev(requestId, 16, 'request_complete', 88010, {
      stage: 'request_complete',
      durationMs: 88010,
      routePolicyKey: 'chat/default'
    })
  ];

  const report = buildRequestTracePreflightDiagnostic({
    rows,
    requestIds: [requestId],
    slowMs: 1000
  });
  assert.strictEqual(report.schemaVersion, 'request_trace_preflight_diagnostic_v1');
  assert.strictEqual(report.requests.length, 1);
  const request = report.requests[0];
  assert.strictEqual(request.requestId, requestId);
  assert.strictEqual(request.segments.ingressToLockMs, 15000);
  assert.strictEqual(request.segments.routeEntryToRouterStartMs, 2998);
  assert.strictEqual(request.segments.plannerMs, 16000);
  assert.strictEqual(request.segments.dispatchToPrepareMs, 2970);
  assert.strictEqual(request.segments.prepareAndRouteToUpstreamMs, 500);
  assert.strictEqual(request.segments.upstreamMs, 50000);
  assert.strictEqual(request.prepare.fastPath, 'plain_private_chat');
  assert.strictEqual(request.dominantPreUpstream.code, 'planner');
  assert.strictEqual(request.slowFlags.plannerMs, 16000);
  assert.ok(formatRequestTracePreflightDiagnostic(report).includes('dominant=planner:16000ms'));

  const parsed = parseArgs(['node', 'script', '--request-id', 'a,b', '--window=2h', '--slow-ms=2500', '--json']);
  assert.deepStrictEqual(parsed.requestIds, ['a', 'b']);
  assert.strictEqual(parsed.sinceMs, 2 * 60 * 60 * 1000);
  assert.strictEqual(parsed.slowMs, 2500);
  assert.strictEqual(parsed.json, true);
  assert.strictEqual(parseDurationMs('15m'), 15 * 60 * 1000);

  console.log('requestTracePreflightDiagnostics.test.js passed');
})();

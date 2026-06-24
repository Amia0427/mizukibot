const assert = require('assert');

const {
  buildMainModelRetryDuplicateDiagnostic,
  formatMainModelRetryDuplicateDiagnostic,
  is408Failure,
  isMainModelCall,
  isMainModelTraceEvent,
  parseArgs,
  parseDurationMs,
  summarizeModelGroup,
  summarizeTraceGroup
} = require('../utils/mainModelRetryDuplicateDiagnostics');

function traceEvent(requestId, phaseSeq, tracePhase, elapsedMs, extra = {}) {
  return {
    recordedAt: new Date(Date.parse('2026-06-23T16:46:00.000Z') + elapsedMs).toISOString(),
    requestId,
    phaseSeq,
    tracePhase,
    stage: tracePhase,
    source: 'direct_reply',
    userId: '1960901788',
    isAdmin: true,
    routePolicyKey: 'transform/vision-summary',
    routeDebugKey: 'direct_chat/image_summary/summary',
    topRouteType: 'direct_chat',
    dispatchBranch: 'direct_reply',
    triggerBranch: 'direct_reply.non_stream',
    provider: 'anthropic',
    model: 'claude-opus-4-6-thinking',
    apiBaseUrlHost: 'cc-coding.cn',
    ...extra
  };
}

function modelCall(requestId, attempt, status, elapsedMs, extra = {}) {
  return {
    ts: new Date(Date.parse('2026-06-23T16:46:00.000Z') + elapsedMs).toISOString(),
    id: `model_call_${requestId}_${attempt}`,
    status,
    source: 'direct_reply',
    request_id: requestId,
    provider: 'anthropic',
    host: 'cc-coding.cn',
    model: 'claude-opus-4-6-thinking',
    user_id: '1960901788',
    user_role: 'admin',
    route_policy_key: 'transform/vision-summary',
    route_debug_key: 'direct_chat/image_summary/summary',
    top_route_type: 'direct_chat',
    dispatch_branch: 'direct_reply',
    trigger_branch: 'direct_reply.non_stream',
    attempts: attempt,
    duration_ms: 33000,
    ...extra
  };
}

module.exports = (() => {
  const requestId = 'req_retry_408';
  const traceRows = [
    traceEvent(requestId, 1, 'http_client_start', 1000, { attempt: 1, maxAttempts: 4 }),
    traceEvent(requestId, 2, 'http_client_failure', 19000, {
      attempt: 1,
      statusCode: 408,
      finalErrorCode: 'http_408',
      retryable: true,
      durationMs: 18000,
      error: 'Request failed with status code 408'
    }),
    traceEvent(requestId, 3, 'http_client_start', 19400, { attempt: 2, maxAttempts: 4 }),
    traceEvent(requestId, 4, 'http_client_failure', 52400, {
      attempt: 2,
      statusCode: 408,
      finalErrorCode: 'http_408',
      retryable: true,
      durationMs: 33000
    }),
    traceEvent(requestId, 5, 'http_client_start', 53200, { attempt: 3, maxAttempts: 4 }),
    traceEvent(requestId, 6, 'http_client_success', 86200, {
      attempt: 3,
      statusCode: 200,
      durationMs: 33000
    })
  ];
  const modelRows = [
    modelCall(requestId, 1, 'failed', 19000, {
      final_error_code: 'http_408',
      error: 'Request failed with status code 408'
    }),
    modelCall(requestId, 2, 'failed', 52400, {
      final_error_code: 'http_408',
      error: 'Request failed with status code 408'
    }),
    modelCall(requestId, 3, 'succeeded', 86200, {
      status_code: 200,
      duration_ms: 33000
    }),
    modelCall('req_non_main', 1, 'failed', 87000, {
      source: 'memoryEmbeddingClient',
      request_id: '',
      final_error_code: 'http_408'
    })
  ];

  assert.strictEqual(is408Failure(traceRows[1]), true);
  assert.strictEqual(is408Failure({ statusCode: 500, error: 'boom' }), false);
  assert.strictEqual(isMainModelTraceEvent(traceRows[0]), true);
  assert.strictEqual(isMainModelCall(modelRows[0]), true);
  assert.strictEqual(isMainModelCall(modelRows[3]), false);

  const traceIncident = summarizeTraceGroup(traceRows);
  assert.strictEqual(traceIncident.requestId, requestId);
  assert.strictEqual(traceIncident.trace.httpStarts, 3);
  assert.strictEqual(traceIncident.trace.failures408, 2);
  assert.strictEqual(traceIncident.trace.retryable408Failures, 2);
  assert.strictEqual(traceIncident.trace.retriedAfter408, true);

  const modelIncident = summarizeModelGroup(modelRows.slice(0, 3));
  assert.strictEqual(modelIncident.modelCalls.rows, 3);
  assert.strictEqual(modelIncident.modelCalls.failures408, 2);
  assert.strictEqual(modelIncident.modelCalls.successAfter408, true);

  const report = buildMainModelRetryDuplicateDiagnostic({
    traceRows,
    modelRows,
    adminOnly: true,
    limit: 5,
    nowMs: Date.parse('2026-06-23T17:00:00.000Z')
  });
  assert.strictEqual(report.schemaVersion, 'main_model_retry_duplicate_diagnostic_v1');
  assert.strictEqual(report.summary.clean, false);
  assert.strictEqual(report.summary.suspiciousRequests, 1);
  assert.strictEqual(report.summary.suspiciousCallGroups, 1);
  assert.strictEqual(report.summary.adminRequestHits, 1);
  assert.strictEqual(report.summary.distinct408Attempts, 2);
  assert.strictEqual(report.incidents[0].requestId, requestId);
  assert.strictEqual(report.incidents[0].trace.failures408, 2);
  assert.strictEqual(report.incidents[0].modelCalls.rows, 3);
  const text = formatMainModelRetryDuplicateDiagnostic(report);
  assert.ok(text.includes('疑似重复主模型调用'));
  assert.ok(text.includes(requestId));
  assert.ok(text.includes('attempts=1,2,3'));

  const cleanReport = buildMainModelRetryDuplicateDiagnostic({
    traceRows: [
      traceEvent('req_single_408', 1, 'http_client_start', 1000, { attempt: 1 }),
      traceEvent('req_single_408', 2, 'http_client_failure', 2000, {
        attempt: 1,
        statusCode: 408,
        retryable: false
      })
    ],
    modelRows: [],
    nowMs: Date.parse('2026-06-23T17:00:00.000Z')
  });
  assert.strictEqual(cleanReport.summary.clean, true);
  assert.ok(formatMainModelRetryDuplicateDiagnostic(cleanReport).includes('未发现'));

  const parsed = parseArgs([
    '--around=2026-06-24T00:47:59+08:00',
    '--window=5m',
    '--limit=3',
    '--admin-only',
    '--json'
  ]);
  assert.strictEqual(parsed.aroundMs, Date.parse('2026-06-24T00:47:59+08:00'));
  assert.strictEqual(parsed.aroundWindowMs, 5 * 60 * 1000);
  assert.strictEqual(parsed.limit, 3);
  assert.strictEqual(parsed.adminOnly, true);
  assert.strictEqual(parsed.json, true);
  assert.strictEqual(parseDurationMs('2h'), 2 * 60 * 60 * 1000);

  console.log('mainModelRetryDuplicateDiagnostics.test.js passed');
})();

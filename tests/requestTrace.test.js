const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

function readJsonLines(filePath = '') {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-request-trace-'));
  let axios = null;
  let originalPost = null;

  try {
    process.env.DATA_DIR = tempDir;
    process.env.API_KEY = 'test-key';
    process.env.MODEL_TLS_IMPERSONATION_ENABLED = 'false';
    process.env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED = 'false';
    clearProjectCache();

    const {
      buildRequestId,
      createRequestTrace,
      appendRequestTraceEvent,
      flushRequestTraceEventsSync,
      nextTracePhase,
      resetRequestTraceStateForTests
    } = require('../utils/requestTrace');
    const { appendInboundTimingLog } = require('../core/messageTelemetry');
    const httpClient = require('../api/httpClient');

    resetRequestTraceStateForTests();

    appendRequestTraceEvent({
      requestId: 'req_privacy_boundary',
      phaseSeq: 1,
      stage: 'privacy_test',
      userId: 'u-safe',
      authorization: 'Bearer exposed-authorization',
      apiKey: 'exposed-api-key',
      token: 'exposed-token',
      password: 'exposed-password',
      prompt: 'private prompt body',
      message: 'private message body',
      arbitrary: { nested: 'must not be logged' },
      error: Object.assign(new Error('request failed authorization=Bearer-secret token=token-secret'), {
        config: { headers: { authorization: 'Bearer nested-secret' } },
        response: { data: { prompt: 'private response body' } }
      })
    });
    flushRequestTraceEventsSync();
    const privacyEvent = readJsonLines(path.join(tempDir, 'request-trace.ndjson'))
      .find((event) => event.requestId === 'req_privacy_boundary');
    assert.ok(privacyEvent);
    assert.strictEqual(privacyEvent.userId, 'u-safe');
    assert.strictEqual(privacyEvent.error, 'request failed authorization=[REDACTED] token=[REDACTED]');
    for (const forbidden of ['authorization', 'apiKey', 'token', 'password', 'prompt', 'message', 'arbitrary']) {
      assert.ok(!(forbidden in privacyEvent), `${forbidden} must not be persisted`);
    }
    assert.ok(!JSON.stringify(privacyEvent).includes('secret'));

    appendRequestTraceEvent({
      requestId: 'req_compatibility_contract',
      phaseSeq: 2,
      stage: 'stream_complete',
      needsBackground: true,
      executor: 'direct',
      planner: 'runtime_v2',
      stream: true,
      apiBaseUrl: 'https://user:pass@example.com/v1?api_key=base-secret',
      requestUrl: 'https://example.com/chat?token=request-secret&mode=stream',
      retry: 'network',
      retryCount: 2,
      tool: 'search',
      replyPath: 'direct_reply',
      finishReason: 'stop',
      streamCompleted: true,
      sent: true,
      streamDoneSeen: true,
      maxAttempts: 3,
      allowTools: true,
      shouldUseTools: true,
      decisionSource: 'route_policy',
      plannerDecisionSource: 'model',
      allowedToolCount: 2,
      allowedToolNames: ['search', 'weather'],
      plannerFallbackUsed: false,
      plannerModel: 'planner-model',
      plannerMode: 'tool_plan',
      plannerStepCount: 1,
      plannerTools: ['search'],
      unavailableReason: 'none',
      fastPath: 'plain_private_chat',
      relationship: 'known',
      tokens: 123,
      hasContext: true,
      needsMemory: true,
      forceMemoryContext: false,
      needsMemoryReason: 'continuity',
      recallFacet: 'profile',
      cache: {
        openaiPromptCacheKey: 'stable-cache-key',
        downgradeReason: 'unsupported_retention'
      },
      plannerMs: 12,
      executorMs: 34,
      streamMs: 56,
      error: 'failed {"authorization": "Bearer json-secret", "password" : "space-secret"}'
    });
    flushRequestTraceEventsSync();
    const compatibilityEvent = readJsonLines(path.join(tempDir, 'request-trace.ndjson'))
      .find((event) => event.requestId === 'req_compatibility_contract');
    assert.deepStrictEqual({
      needsBackground: compatibilityEvent.needsBackground,
      executor: compatibilityEvent.executor,
      planner: compatibilityEvent.planner,
      stream: compatibilityEvent.stream,
      retryCount: compatibilityEvent.retryCount,
      tool: compatibilityEvent.tool,
      replyPath: compatibilityEvent.replyPath,
      finishReason: compatibilityEvent.finishReason,
      streamCompleted: compatibilityEvent.streamCompleted,
      plannerMs: compatibilityEvent.plannerMs,
      executorMs: compatibilityEvent.executorMs,
      streamMs: compatibilityEvent.streamMs
    }, {
      needsBackground: true,
      executor: 'direct',
      planner: 'runtime_v2',
      stream: true,
      retryCount: 2,
      tool: 'search',
      replyPath: 'direct_reply',
      finishReason: 'stop',
      streamCompleted: true,
      plannerMs: 12,
      executorMs: 34,
      streamMs: 56
    });
    assert.strictEqual(compatibilityEvent.fastPath, 'plain_private_chat');
    assert.ok(!JSON.stringify(compatibilityEvent).includes('secret'));
    assert.strictEqual(compatibilityEvent.apiBaseUrl, 'https://example.com');
    assert.strictEqual(compatibilityEvent.requestUrl, 'https://example.com');
    assert.deepStrictEqual(compatibilityEvent.allowedToolNames, ['search', 'weather']);
    assert.deepStrictEqual(compatibilityEvent.plannerTools, ['search']);
    assert.strictEqual(compatibilityEvent.cache.openaiPromptCacheKey, 'stable-cache-key');
    assert.strictEqual(compatibilityEvent.cache.downgradeReason, 'unsupported_retention');

    appendRequestTraceEvent({
      requestId: 'req_token=identifier-secret',
      phaseSeq: 3,
      stage: 'request_id_safety',
      error: 'headers {"access_token":"ACCESS_LEAK","client_secret" : "CLIENT_LEAK","refresh_token":"REFRESH_LEAK","set-cookie":"COOKIE_LEAK"}'
    });
    flushRequestTraceEventsSync();
    const safeIdEvent = readJsonLines(path.join(tempDir, 'request-trace.ndjson'))
      .find((event) => event.stage === 'request_id_safety');
    assert.ok(safeIdEvent);
    for (const leakedValue of ['identifier-secret', 'ACCESS_LEAK', 'CLIENT_LEAK', 'REFRESH_LEAK', 'COOKIE_LEAK']) {
      assert.ok(!JSON.stringify(safeIdEvent).includes(leakedValue));
    }
    assert.ok(safeIdEvent.requestId.length <= 160);

    const requestId = buildRequestId({
      chatType: 'group',
      groupId: 'g1',
      userId: 'u1',
      messageId: 'm1'
    });
    assert.strictEqual(requestId, buildRequestId({
      chatType: 'group',
      groupId: 'g1',
      userId: 'u1',
      messageId: 'm1'
    }));

    const trace = createRequestTrace({
      source: 'message_ingress',
      chatType: 'group',
      groupId: 'g1',
      userId: 'u1',
      messageId: 'm1',
      isAdmin: true
    });
    assert.strictEqual(trace.requestId, requestId);

    const timingLogFile = path.join(tempDir, 'inbound-timing.jsonl');
    appendInboundTimingLog(timingLogFile, false, nextTracePhase(trace, 'message_ingress', {
      stage: 'handle_incoming_start'
    }));
    flushRequestTraceEventsSync();

    const traceFile = path.join(tempDir, 'request-trace.ndjson');
    let traceEvents = readJsonLines(traceFile);
    assert.ok(traceEvents.some((event) => event.requestId === requestId && event.stage === 'handle_incoming_start'));
    assert.ok(traceEvents.every((event) => Number(event.phaseSeq) > 0));

    axios = require('axios');
    originalPost = axios.post;
    axios.post = async () => {
      const error = new Error('rate limited');
      error.response = {
        status: 429,
        data: {
          error: {
            message: 'rate limited'
          }
        }
      };
      throw error;
    };

    await assert.rejects(
      () => httpClient.postWithRetry('https://example.com/v1/chat/completions', {
        model: 'trace-test-model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        __trace: {
          ...trace,
          source: 'runtimeV2',
          phase: 'runtime_model',
          purpose: 'unit_test',
          provider: 'openai_compatible',
          routeDebugKey: 'direct_chat/text_chat/answer',
          routePolicyKey: 'direct_chat/default',
          topRouteType: 'direct_chat',
          dispatchBranch: 'direct_reply',
          triggerBranch: 'direct_reply.final_send',
          modelSource: 'AI_MODEL',
          apiBaseUrlSource: 'API_BASE_URL',
          apiKeySource: 'API_KEY'
        }
      }, 0, 'test-key'),
      /rate limited/
    );

    flushRequestTraceEventsSync();
    require('../utils/modelCallTracker').flushModelCallLogsSync();
    traceEvents = readJsonLines(traceFile);
    const httpFailure = traceEvents.find((event) => event.stage === 'http_client_failure' && event.requestId === requestId);
    assert.ok(httpFailure);
    assert.strictEqual(httpFailure.provider, 'openai_compatible');
    assert.strictEqual(httpFailure.model, 'trace-test-model');
    assert.strictEqual(httpFailure.statusCode, 429);
    assert.strictEqual(httpFailure.finalErrorCode, 'http_429');
    assert.strictEqual(httpFailure.routeDebugKey, 'direct_chat/text_chat/answer');
    assert.strictEqual(httpFailure.routePolicyKey, 'direct_chat/default');
    assert.strictEqual(httpFailure.dispatchBranch, 'direct_reply');
    assert.strictEqual(httpFailure.triggerBranch, 'direct_reply.final_send');
    assert.strictEqual(httpFailure.apiBaseUrlHost, 'example.com');
    assert.strictEqual(httpFailure.modelSource, 'AI_MODEL');
    assert.strictEqual(httpFailure.apiBaseUrlSource, 'API_BASE_URL');
    assert.strictEqual(httpFailure.modelRouteDiagnostic.routeDebugKey, 'direct_chat/text_chat/answer');
    assert.ok(traceEvents.some((event) => event.stage === 'http_client_start' && event.cache));

    const phaseSeqs = traceEvents
      .filter((event) => event.requestId === requestId)
      .map((event) => Number(event.phaseSeq || 0));
    assert.deepStrictEqual(phaseSeqs, [...phaseSeqs].sort((a, b) => a - b));

    const modelCalls = readJsonLines(path.join(tempDir, 'model-calls.ndjson'));
    const failedCall = modelCalls.find((event) => event.request_id === requestId && event.status === 'failed');
    assert.ok(failedCall);
    assert.strictEqual(failedCall.final_error_code, 'http_429');
    assert.strictEqual(failedCall.provider, 'openai_compatible');
    assert.strictEqual(failedCall.model, 'trace-test-model');
    assert.strictEqual(failedCall.route_debug_key, 'direct_chat/text_chat/answer');
    assert.strictEqual(failedCall.route_policy_key, 'direct_chat/default');
    assert.strictEqual(failedCall.dispatch_branch, 'direct_reply');
    assert.strictEqual(failedCall.trigger_branch, 'direct_reply.final_send');
    assert.strictEqual(failedCall.api_base_url_host, 'example.com');
    assert.strictEqual(failedCall.model_source, 'AI_MODEL');
    assert.strictEqual(failedCall.api_base_url_source, 'API_BASE_URL');
    assert.strictEqual(failedCall.model_route_diagnostic.routeDebugKey, 'direct_chat/text_chat/answer');
    assert.ok(Number(failedCall.trace_phase_seq) > 0);

    console.log('requestTrace.test.js passed');
  } finally {
    if (axios && originalPost) axios.post = originalPost;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

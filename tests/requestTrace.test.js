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
    clearProjectCache();

    const {
      buildRequestId,
      createRequestTrace,
      nextTracePhase,
      resetRequestTraceStateForTests
    } = require('../utils/requestTrace');
    const { appendInboundTimingLog } = require('../core/messageTelemetry');
    const httpClient = require('../api/httpClient');

    resetRequestTraceStateForTests();

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
          routePolicyKey: 'direct_chat/default',
          topRouteType: 'direct_chat'
        }
      }, 0, 'test-key'),
      /rate limited/
    );

    traceEvents = readJsonLines(traceFile);
    const httpFailure = traceEvents.find((event) => event.stage === 'http_client_failure' && event.requestId === requestId);
    assert.ok(httpFailure);
    assert.strictEqual(httpFailure.provider, 'openai_compatible');
    assert.strictEqual(httpFailure.model, 'trace-test-model');
    assert.strictEqual(httpFailure.statusCode, 429);
    assert.strictEqual(httpFailure.finalErrorCode, 'http_429');
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

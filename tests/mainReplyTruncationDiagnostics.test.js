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

module.exports = (() => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-main-reply-trunc-diag-'));
  const modelLogFile = path.join(tempDir, 'model-calls.ndjson');
  const traceFile = path.join(tempDir, 'request-trace.ndjson');

  try {
    process.env.DATA_DIR = tempDir;
    clearProjectCache();

    const modelRows = [
      {
        ts: '2026-06-06T00:00:00.000Z',
        id: 'ignored_embedding',
        status: 'succeeded',
        source: 'memoryEmbeddingClient',
        finish_reason: 'MAX_TOKENS'
      },
      {
        ts: '2026-06-06T00:00:01.000Z',
        id: 'call_max',
        request_id: 'req_max',
        status: 'succeeded',
        source: 'v2_assistant_message',
        provider: 'gemini_native',
        model: 'gemini-test',
        top_route_type: 'direct_chat',
        route_debug_key: 'direct_chat/text_chat/answer',
        dispatch_branch: 'direct_reply',
        finish_reason: 'MAX_TOKENS',
        max_tokens: 800,
        usage: { completion_tokens: 800 }
      },
      {
        ts: '2026-06-06T00:00:02.000Z',
        id: 'call_reset',
        request_id: 'req_reset',
        status: 'failed',
        source: 'v2_streaming_reply',
        provider: 'openai_compatible',
        model: 'gateway-model',
        top_route_type: 'direct_chat',
        route_debug_key: 'direct_chat/text_chat/answer',
        dispatch_branch: 'direct_reply',
        final_error_code: 'ECONNRESET',
        error: 'socket hang up'
      },
      {
        ts: '2026-06-06T00:00:03.000Z',
        id: 'call_no_terminal',
        request_id: 'req_no_terminal',
        status: 'succeeded',
        source: 'v2_streaming_reply',
        provider: 'openai_compatible',
        model: 'gateway-model',
        top_route_type: 'direct_chat',
        route_debug_key: 'direct_chat/text_chat/answer',
        dispatch_branch: 'direct_reply',
        finish_reason: 'stream_closed_without_terminal_event'
      },
      {
        ts: '2026-06-06T00:00:04.000Z',
        id: 'call_send_failed',
        request_id: 'req_send_failed',
        status: 'succeeded',
        source: 'v2_assistant_message',
        provider: 'anthropic',
        model: 'claude-test',
        top_route_type: 'direct_chat',
        route_debug_key: 'direct_chat/text_chat/answer',
        dispatch_branch: 'direct_reply',
        finish_reason: 'stop'
      },
      {
        ts: '2026-06-06T00:00:05.000Z',
        id: 'call_trace_no_terminal',
        request_id: 'req_trace_no_terminal',
        status: 'succeeded',
        source: 'v2_streaming_reply',
        provider: 'openai_compatible',
        model: 'gateway-model',
        top_route_type: 'direct_chat',
        route_debug_key: 'direct_chat/text_chat/answer',
        dispatch_branch: 'direct_reply',
        finish_reason: ''
      },
      {
        ts: '2026-06-06T00:00:06.000Z',
        id: 'call_retry_canceled',
        request_id: 'req_retry_canceled',
        status: 'failed',
        source: 'v2_streaming_reply',
        provider: 'openai_compatible',
        model: 'gateway-model',
        top_route_type: 'direct_chat',
        route_debug_key: 'direct_chat/text_chat/answer',
        dispatch_branch: 'direct_reply',
        final_error_code: 'ERR_CANCELED',
        error: 'canceled'
      },
      {
        ts: '2026-06-06T00:00:07.000Z',
        id: 'call_ok',
        request_id: 'req_ok',
        status: 'succeeded',
        source: 'v2_assistant_message',
        provider: 'anthropic',
        model: 'claude-test',
        top_route_type: 'direct_chat',
        route_debug_key: 'direct_chat/text_chat/answer',
        dispatch_branch: 'direct_reply',
        finish_reason: 'stop'
      }
    ];
    const traceRows = [
      {
        recordedAt: '2026-06-06T00:00:02.100Z',
        requestId: 'req_reset',
        stage: 'http_client_failure',
        finalErrorCode: 'ECONNRESET',
        error: 'read ECONNRESET'
      },
      {
        recordedAt: '2026-06-06T00:00:03.100Z',
        requestId: 'req_no_terminal',
        stage: 'http_client_success',
        finishReason: 'stream_closed_without_terminal_event',
        streamDoneSeen: false
      },
      {
        recordedAt: '2026-06-06T00:00:04.100Z',
        requestId: 'req_send_failed',
        stage: 'final_reply_send_done',
        sent: false,
        finalErrorCode: 'reply_send_failed'
      },
      {
        recordedAt: '2026-06-06T00:00:05.100Z',
        requestId: 'req_trace_no_terminal',
        stage: 'http_client_success',
        finishReason: 'stream_closed_without_terminal_event',
        streamDoneSeen: false
      },
      {
        recordedAt: '2026-06-06T00:00:06.050Z',
        requestId: 'req_retry_canceled',
        stage: 'http_client_failure',
        finalErrorCode: 'ECONNRESET',
        error: 'socket hang up'
      },
      {
        recordedAt: '2026-06-06T00:00:06.100Z',
        requestId: 'req_retry_canceled',
        stage: 'http_client_failure',
        finalErrorCode: 'ERR_CANCELED',
        error: 'canceled'
      },
      {
        recordedAt: '2026-06-06T00:00:07.100Z',
        requestId: 'req_ok',
        stage: 'final_reply_send_done',
        sent: true
      }
    ];
    fs.writeFileSync(modelLogFile, `${modelRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    fs.writeFileSync(traceFile, `${traceRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    const {
      TRUNCATION_SCHEMA_VERSION,
      buildMainReplyTruncationDiagnostic
    } = require('../utils/mainReplyDiagnostics');
    const script = require('../scripts/diagnose-main-reply');
    const report = buildMainReplyTruncationDiagnostic({
      logFile: modelLogFile,
      traceFile,
      limit: 10
    });
    const parsedArgs = script.parseArgs([
      'node',
      'scripts/diagnose-main-reply.js',
      '--truncation',
      '--limit',
      '4',
      '--read-limit=100'
    ]);

    assert.strictEqual(report.schemaVersion, TRUNCATION_SCHEMA_VERSION);
    assert.strictEqual(parsedArgs.truncation, true);
    assert.strictEqual(parsedArgs.limit, 4);
    assert.strictEqual(parsedArgs.readLimit, 100);
    assert.strictEqual(report.rowsRead, 8);
    assert.strictEqual(report.traceRowsRead, 7);
    assert.strictEqual(report.sampleCount, 6);
    assert.strictEqual(report.summary.noRecentTruncationCandidates, false);
    assert.deepStrictEqual(
      report.summary.topReasons.map((item) => [item.key, item.count]),
      [
        ['NO_TERMINAL_EVENT', 2],
        ['UPSTREAM_DISCONNECT', 2],
        ['LOCAL_SEND_LAYER', 1],
        ['MAX_TOKENS', 1]
      ]
    );
    assert.ok(report.summary.topSignals.some((item) => item.key === 'max_tokens_finish_reason' && item.count === 1));
    assert.ok(report.summary.topSignals.some((item) => item.key === 'upstream_stream_reset_or_disconnect' && item.count === 2));
    assert.ok(report.summary.topSignals.some((item) => item.key === 'stream_closed_without_terminal_event' && item.count === 2));
    assert.ok(report.summary.topSignals.some((item) => item.key === 'local_send_layer_failure' && item.count === 1));
    assert.strictEqual(report.summary.latest.id, 'call_retry_canceled');
    assert.strictEqual(report.summary.latest.primaryReason, 'UPSTREAM_DISCONNECT');
    assert.ok(report.samples.some((sample) => sample.id === 'call_trace_no_terminal' && sample.primaryReason === 'NO_TERMINAL_EVENT'));
    const sendFailure = report.samples.find((sample) => sample.id === 'call_send_failed');
    assert.strictEqual(sendFailure.primaryReason, 'LOCAL_SEND_LAYER');
    assert.strictEqual(sendFailure.trace.sendEvents[0].sent, false);
    assert.ok(!report.samples.some((sample) => sample.id === 'ignored_embedding'));
    assert.ok(!report.samples.some((sample) => sample.id === 'call_ok'));

    console.log('mainReplyTruncationDiagnostics.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})();

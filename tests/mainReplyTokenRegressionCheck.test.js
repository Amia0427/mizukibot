const assert = require('assert');

const {
  buildMainReplyTokenRegressionReport,
  formatMainReplyTokenRegressionReport,
  parseArgs,
  parseTimestampMs
} = require('../scripts/verify-main-reply-token-budget');

function modelCall(requestId, tokens, ts, extra = {}) {
  return {
    ts,
    id: `model_call_${requestId}`,
    status: 'succeeded',
    source: 'draft_reply',
    request_id: requestId,
    provider: 'anthropic',
    model: 'claude-opus-4-6-thinking',
    user_id: '1960901788',
    user_role: 'admin',
    route_policy_key: 'lookup/notebook-answer',
    route_debug_key: 'direct_chat/text_chat/answer',
    top_route_type: 'direct_chat',
    dispatch_branch: 'tool_plan',
    trigger_branch: 'draft_reply.followup_after_tools',
    prompt_integrity: {
      token_budget: {
        estimated_input_tokens: tokens
      }
    },
    ...extra
  };
}

function traceEvent(requestId, phaseSeq, tracePhase, ts, extra = {}) {
  return {
    recordedAt: ts,
    requestId,
    phaseSeq,
    tracePhase,
    stage: tracePhase,
    ...extra
  };
}

module.exports = (() => {
  const since = '2026-06-26T22:13:00+08:00';
  const modelRows = [
    modelCall('req_old_peak', 24353, '2026-06-26T13:59:00.000Z'),
    modelCall('req_ok', 17876, '2026-06-26T14:37:44.316Z'),
    modelCall('req_over', 22001, '2026-06-26T15:00:00.000Z'),
    modelCall('req_image_over', 50000, '2026-06-26T15:01:00.000Z', {
      route_debug_key: 'direct_chat/image_summary/summary'
    }),
    modelCall('', 50000, '2026-06-26T15:02:00.000Z', {
      source: 'memoryEmbeddingClient',
      request_id: ''
    })
  ];
  const traceRows = [
    traceEvent('req_over', 1, 'final_reply_send_done', '2026-06-26T15:00:10.000Z', {
      sent: true
    }),
    traceEvent('req_over', 2, 'request_complete', '2026-06-26T15:00:11.000Z', {
      sent: true,
      chatType: 'private'
    })
  ];

  const report = buildMainReplyTokenRegressionReport({
    modelRows,
    traceRows,
    since,
    sinceMs: parseTimestampMs(since),
    threshold: 20000,
    limit: 5
  });
  assert.strictEqual(report.schemaVersion, 'main_reply_token_regression_check_v1');
  assert.strictEqual(report.summary.clean, false);
  assert.strictEqual(report.summary.samples, 2);
  assert.strictEqual(report.summary.maxInputTokens, 22001);
  assert.strictEqual(report.summary.violationCount, 1);
  assert.strictEqual(report.violations[0].requestId, 'req_over');
  assert.strictEqual(report.violations[0].tokens, 22001);
  assert.strictEqual(report.violations[0].completed, true);
  assert.strictEqual(report.violations[0].sent, true);
  const text = formatMainReplyTokenRegressionReport(report);
  assert.ok(text.includes('req_over'));
  assert.ok(text.includes('tokens=22001'));

  const cleanReport = buildMainReplyTokenRegressionReport({
    modelRows,
    traceRows,
    since,
    sinceMs: parseTimestampMs(since),
    threshold: 23000
  });
  assert.strictEqual(cleanReport.summary.clean, true);
  assert.strictEqual(cleanReport.summary.samples, 2);
  assert.strictEqual(cleanReport.summary.violationCount, 0);

  const imageReport = buildMainReplyTokenRegressionReport({
    modelRows,
    traceRows,
    since,
    sinceMs: parseTimestampMs(since),
    threshold: 20000,
    includeImages: true
  });
  assert.strictEqual(imageReport.summary.samples, 3);
  assert.strictEqual(imageReport.summary.violationCount, 2);

  const parsed = parseArgs([
    '--since=2026-06-26T22:13:00+08:00',
    '--threshold=20000',
    '--limit=3',
    '--include-images',
    '--json'
  ]);
  assert.strictEqual(parsed.sinceMs, parseTimestampMs('2026-06-26T22:13:00+08:00'));
  assert.strictEqual(parsed.threshold, 20000);
  assert.strictEqual(parsed.limit, 3);
  assert.strictEqual(parsed.includeImages, true);
  assert.strictEqual(parsed.json, true);

  console.log('mainReplyTokenRegressionCheck.test.js passed');
})();

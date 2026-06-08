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

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

module.exports = (() => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-runtime-exceptions-'));
  const dataDir = path.join(tempDir, 'data');
  const modelLog = path.join(dataDir, 'model-calls.ndjson');
  const memoryRecallLog = path.join(dataDir, 'memory-recall-observability.ndjson');
  const botErrLog = path.join(dataDir, 'bot-runtime.err.log');
  const now = Date.parse('2026-06-08T06:00:00.000Z');

  try {
    process.env.DATA_DIR = dataDir;
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    clearProjectCache();

    appendJsonLine(modelLog, {
      ts: '2026-06-08T05:10:00.000Z',
      status: 'failed',
      source: 'v2_streaming_reply',
      phase: '',
      user_id: 'admin-user',
      user_role: 'admin',
      route_policy_key: 'chat/default',
      top_route_type: 'direct_chat',
      model: 'admin-primary-model',
      host: 'admin-primary.example',
      main_fallback_scope: 'admin_shared',
      main_fallback_active: false,
      error: 'socket hang up',
      final_error_code: 'ECONNRESET',
      request_id: 'req_admin_1'
    });
    appendJsonLine(modelLog, {
      ts: '2026-06-08T05:13:00.000Z',
      status: 'succeeded',
      source: 'v2_streaming_reply',
      user_id: 'admin-user',
      user_role: 'admin',
      route_policy_key: 'chat/default',
      top_route_type: 'direct_chat',
      model: 'admin-fallback-model',
      host: 'admin-fallback.example',
      main_fallback_scope: 'admin_shared',
      main_fallback_active: true,
      request_id: 'req_admin_2'
    });
    appendJsonLine(modelLog, {
      ts: '2026-06-08T05:20:00.000Z',
      status: 'failed',
      source: 'memoryReranker',
      phase: 'memory_v3',
      purpose: 'memory_rerank',
      user_id: 'u1',
      model: 'test-reranker',
      host: 'rerank.example',
      error: 'rerank request timed out after 800ms',
      final_error_code: 'ERR_MEMORY_RERANK_TIMEOUT'
    });
    appendJsonLine(memoryRecallLog, {
      recordedAt: '2026-06-08T05:21:00.000Z',
      stage: 'prepare_main_prompt_blocks',
      userId: 'u1',
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat',
      memoryTrace: {
        dropped_reasons: ['rerank_timeout', 'bm25_empty']
      }
    });
    fs.mkdirSync(path.dirname(botErrLog), { recursive: true });
    fs.writeFileSync(
      botErrLog,
      [
        '[2026-06-08T05:12:00.000Z] [main-model-fallback:admin_shared] activated backup model after repeated request failures',
        '[2026-06-08T05:22:00.000Z] [memoryReranker] rerank request timed out after 800ms, fallback to base recall'
      ].join('\n'),
      'utf8'
    );

    const {
      buildRuntimeExceptionDiagnostic,
      buildRuntimeExceptionText,
      parseWindowMs
    } = require('../utils/runtimeExceptionDiagnostics');
    const report = buildRuntimeExceptionDiagnostic({
      now: () => now,
      windowMs: 2 * 60 * 60 * 1000,
      maxLines: 1000,
      logFiles: [botErrLog],
      runtimeStatus: {
        overallStatus: 'ok',
        signalCount: 0,
        signals: []
      }
    });

    assert.strictEqual(parseWindowMs('2h'), 2 * 60 * 60 * 1000);
    assert.strictEqual(report.schemaVersion, 'runtime_exception_diagnostic_v1');
    assert.strictEqual(report.summary.overallStatus, 'warning');
    assert.deepStrictEqual(report.summary.signals, [
      'main-model-fallback:admin_shared',
      'memoryReranker-timeout-fallback'
    ]);

    const adminSignal = report.signals.find((item) => item.code === 'main-model-fallback:admin_shared');
    assert.strictEqual(adminSignal.count, 1);
    assert.strictEqual(adminSignal.breakdown.activationWarnings, 1);
    assert.strictEqual(adminSignal.breakdown.primaryFailures, 1);
    assert.strictEqual(adminSignal.breakdown.fallbackActiveCalls, 1);
    assert.strictEqual(adminSignal.lastOccurrenceAt, '2026-06-08T05:12:00.000Z');
    assert.ok(adminSignal.affectedModules.some((item) => item.key === 'mainModelFallback/admin_shared'));
    assert.ok(adminSignal.relatedEvidence.some((item) => item.sourceType === 'model_call'));

    const rerankerSignal = report.signals.find((item) => item.code === 'memoryReranker-timeout-fallback');
    assert.strictEqual(rerankerSignal.count, 3);
    assert.strictEqual(rerankerSignal.breakdown.timeoutWarnings, 1);
    assert.strictEqual(rerankerSignal.breakdown.timeoutModelFailures, 1);
    assert.strictEqual(rerankerSignal.breakdown.promptDropReasons, 1);
    assert.strictEqual(rerankerSignal.lastOccurrenceAt, '2026-06-08T05:22:00.000Z');
    assert.ok(rerankerSignal.affectedModules.some((item) => item.key === 'memoryReranker'));
    assert.ok(rerankerSignal.affectedModules.some((item) => item.key === 'memory-v3/prepare_main_prompt_blocks'));

    const text = buildRuntimeExceptionText(report);
    assert.ok(text.includes('runtime-exceptions: warning'));
    assert.ok(text.includes('main-model-fallback:admin_shared'));
    assert.ok(text.includes('memoryReranker-timeout-fallback'));
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));

    console.log('runtimeExceptionDiagnostics.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
})();

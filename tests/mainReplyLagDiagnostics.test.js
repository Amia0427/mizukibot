const assert = require('assert');

const {
  buildMainReplyLagDiagnostic,
  buildMainReplyLagDiagnosticText,
  parseWindowMs
} = require('../utils/mainReplyLagDiagnostics');
const {
  parseArgs
} = require('../scripts/diagnose-main-reply-lag');

module.exports = (async () => {
  const now = Date.parse('2026-05-30T10:00:00.000Z');
  const perfEvents = [
    {
      recordedAt: '2026-05-30T09:50:00.000Z',
      category: 'reply_event',
      type: 'planner_done',
      module: 'planner',
      durationMs: 60000
    },
    {
      recordedAt: '2026-05-30T09:51:00.000Z',
      category: 'reply_event',
      type: 'planner_done',
      module: 'planner',
      durationMs: 62000
    },
    {
      recordedAt: '2026-05-30T09:52:00.000Z',
      category: 'reply_event',
      type: 'reply_send_success',
      stage: 'reply_send_success',
      durationMs: 42
    }
  ];
  const modelCallRows = [
    {
      ts: '2026-05-30T09:53:00.000Z',
      source: 'v2_assistant_message',
      status: 'succeeded',
      provider: 'openai_compatible',
      model: 'diag-main-model',
      route_debug_key: 'direct_chat/text_chat/answer',
      top_route_type: 'direct_chat',
      duration_ms: 45000
    },
    {
      ts: '2026-05-30T09:54:00.000Z',
      source: 'v2_streaming_reply',
      status: 'succeeded',
      provider: 'openai_compatible',
      model: 'diag-main-model',
      route_debug_key: 'direct_chat/text_chat/answer',
      top_route_type: 'direct_chat',
      duration_ms: 47000
    }
  ];
  const status = {
    summary: {
      overallStatus: 'ok',
      postReplyWorker: {
        status: 'running',
        processCount: 1,
        queue: { queued: 2, processing: 1, failed: 0 }
      }
    }
  };
  const hotspots = {
    summary: {
      overallStatus: 'warning',
      postReplyWorker: {
        status: 'running',
        processCount: 1,
        active: { latest: 1, max: 2, samples: 2 },
        queue: { queued: 2, processing: 1, failed: 0 }
      },
      processRssMb: {
        postReplyMax: 512
      },
      localMcpChildren: {
        processCount: 0,
        rssMb: { total: 0, max: 0 }
      },
      memoryBackfill: {
        processCount: 0,
        rssMb: { total: 0, max: 0 }
      }
    }
  };
  const lowResource = {
    ok: true,
    failedChecks: [],
    summary: {
      config: {
        postReplyWorkerRssRecycleMb: 768
      }
    }
  };

  const report = await buildMainReplyLagDiagnostic({
    now: () => now,
    windowMs: 30 * 60 * 1000,
    perfEvents,
    modelCallRows,
    status,
    hotspots,
    lowResource,
    config: {
      POST_REPLY_WORKER_RSS_RECYCLE_MB: 768
    }
  });

  assert.strictEqual(report.schemaVersion, 'main_reply_lag_diagnostic_v1');
  assert.strictEqual(report.metrics.planner.count, 2);
  assert.strictEqual(report.metrics.planner.p95Ms, 62000);
  assert.strictEqual(report.metrics.mainModel.count, 2);
  assert.strictEqual(report.metrics.mainModel.p95Ms, 47000);
  assert.strictEqual(report.metrics.send.count, 1);
  assert.strictEqual(report.metrics.send.p95Ms, 42);
  assert.strictEqual(report.metrics.postReplyWorker.rssMaxMb, 512);
  assert.strictEqual(report.metrics.postReplyWorker.pressure, 'ok');
  assert.strictEqual(report.summary.mostLikelyBottleneck.code, 'planner');
  assert.deepStrictEqual(report.summary.missingFields, []);

  const text = buildMainReplyLagDiagnosticText(report);
  assert.ok(text.includes('main-reply-lag: bottleneck=planner'));
  assert.ok(text.includes('planner: p50=60000ms p95=62000ms'));
  assert.ok(text.includes('main-model: p50=45000ms p95=47000ms'));
  assert.ok(text.includes('post-reply-rss: pressure=ok rssMax=512MB threshold=768MB'));

  const pressureReport = await buildMainReplyLagDiagnostic({
    now: () => now,
    windowMs: 30 * 60 * 1000,
    perfEvents: [
      {
        recordedAt: '2026-05-30T09:52:00.000Z',
        type: 'reply_send_success',
        durationMs: 20
      }
    ],
    modelCallRows: [
      {
        ts: '2026-05-30T09:53:00.000Z',
        source: 'v2_assistant_message',
        status: 'succeeded',
        top_route_type: 'direct_chat',
        route_debug_key: 'direct_chat/text_chat/answer',
        duration_ms: 1000
      }
    ],
    status,
    hotspots: {
      summary: {
        ...hotspots.summary,
        processRssMb: { postReplyMax: 900 }
      }
    },
    lowResource,
    config: {
      POST_REPLY_WORKER_RSS_RECYCLE_MB: 768
    }
  });
  assert.strictEqual(pressureReport.metrics.postReplyWorker.pressure, 'critical');
  assert.strictEqual(pressureReport.summary.mostLikelyBottleneck.code, 'post_reply_rss');
  assert.ok(pressureReport.summary.missingFields.includes('planner_duration'));

  assert.strictEqual(parseWindowMs('15m'), 15 * 60 * 1000);
  assert.strictEqual(parseWindowMs('2h'), 2 * 60 * 60 * 1000);
  assert.strictEqual(parseArgs(['node', 'diag']).includeProvider, true);
  assert.strictEqual(parseArgs(['node', 'diag', '--no-provider-diagnostic']).includeProvider, false);

  const traceFallbackReport = await buildMainReplyLagDiagnostic({
    now: () => now,
    windowMs: 30 * 60 * 1000,
    perfEvents: [],
    traceEvents: [
      {
        recordedAt: '2026-05-30T09:55:00.000Z',
        stage: 'direct_chat_planner_done',
        durationMs: 1200
      },
      {
        recordedAt: '2026-05-30T09:56:00.000Z',
        stage: 'final_reply_send_done',
        durationMs: 35
      }
    ],
    modelCallRows,
    status,
    hotspots,
    lowResource,
    config: {
      POST_REPLY_WORKER_RSS_RECYCLE_MB: 768
    }
  });
  assert.strictEqual(traceFallbackReport.inputs.traceEvents, 2);
  assert.strictEqual(traceFallbackReport.metrics.planner.p95Ms, 1200);
  assert.strictEqual(traceFallbackReport.metrics.send.p95Ms, 35);

  console.log('mainReplyLagDiagnostics.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

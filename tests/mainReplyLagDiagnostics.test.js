const assert = require('assert');

const {
  buildMainReplyLagDiagnostic,
  buildMainReplyLagDiagnosticText,
  isGenerationEvent,
  isSendEvent,
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
  assert.strictEqual(report.metrics.generation.count, 0);
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
  assert.ok(text.includes('generation: p50=0ms p95=0ms max=0ms samples=0 source=final_reply_send_done(stream).generationDurationMs'));
  assert.ok(text.includes('send: p50=42ms p95=42ms max=42ms samples=1 source=reply_send_success/failure'));
  assert.ok(text.includes('post-reply-rss: pressure=ok rssMax=512MB threshold=768MB'));

  const splitSendAndGenerationReport = await buildMainReplyLagDiagnostic({
    now: () => now,
    windowMs: 30 * 60 * 1000,
    perfEvents: [
      {
        recordedAt: '2026-05-30T09:55:00.000Z',
        type: 'reply_send_success',
        stage: 'reply_send_success',
        durationMs: 42
      },
      {
        recordedAt: '2026-05-30T09:56:00.000Z',
        stage: 'final_reply_send_done',
        stream: true,
        streamCompleted: true,
        durationMs: 120,
        generationDurationMs: 98000
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
  assert.strictEqual(isSendEvent({ stage: 'reply_send_success', durationMs: 42 }), true);
  assert.strictEqual(isSendEvent({ stage: 'final_reply_send_done', stream: true, durationMs: 98000 }), false);
  assert.strictEqual(isGenerationEvent({ stage: 'final_reply_send_done', stream: true, durationMs: 120, generationDurationMs: 98000 }), true);
  assert.strictEqual(isGenerationEvent({ stage: 'final_reply_send_done', durationMs: 42 }), false);
  assert.strictEqual(splitSendAndGenerationReport.metrics.send.count, 1);
  assert.strictEqual(splitSendAndGenerationReport.metrics.send.p95Ms, 42);
  assert.strictEqual(splitSendAndGenerationReport.summary.sendP95Ms, 42);
  assert.strictEqual(splitSendAndGenerationReport.metrics.generation.count, 1);
  assert.strictEqual(splitSendAndGenerationReport.metrics.generation.p95Ms, 98000);
  assert.strictEqual(splitSendAndGenerationReport.summary.generationP95Ms, 98000);
  assert.strictEqual(splitSendAndGenerationReport.summary.mostLikelyBottleneck.code, 'generation');
  const splitText = buildMainReplyLagDiagnosticText(splitSendAndGenerationReport);
  assert.ok(splitText.includes('generation: p50=98000ms p95=98000ms max=98000ms samples=1 source=final_reply_send_done(stream).generationDurationMs'));
  assert.ok(splitText.includes('send: p50=42ms p95=42ms max=42ms samples=1 source=reply_send_success/failure'));

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
  assert.strictEqual(traceFallbackReport.metrics.generation.p95Ms, 0);
  assert.strictEqual(traceFallbackReport.metrics.send.p95Ms, 0);

  const degradedReport = await buildMainReplyLagDiagnostic({
    now: () => now,
    windowMs: 30 * 60 * 1000,
    perfEvents,
    modelCallRows,
    includeProvider: true,
    config: {
      POST_REPLY_WORKER_RSS_RECYCLE_MB: 768
    },
    buildRuntimeStatusDiagnostic: () => {
      throw new Error('status unavailable');
    },
    buildRuntimeHotspotsDiagnostic: () => {
      throw new Error('hotspots unavailable');
    },
    buildLowResourceHealthReport: () => {
      throw new Error('low resource unavailable');
    },
    runProviderRequestDiagnostics: async () => {
      throw new Error('provider unavailable');
    }
  });
  assert.strictEqual(degradedReport.metrics.planner.p95Ms, 62000);
  assert.strictEqual(degradedReport.metrics.mainModel.p95Ms, 47000);
  assert.strictEqual(degradedReport.metrics.postReplyWorker.pressure, 'ok');
  assert.strictEqual(degradedReport.diagnostics.runtimeStatus.overallStatus, 'error');
  assert.strictEqual(degradedReport.diagnostics.hotspots.overallStatus, 'error');
  assert.strictEqual(degradedReport.diagnostics.lowResource.ok, false);
  assert.strictEqual(degradedReport.providerRequest.summary.overallStatus, 'error');
  assert.deepStrictEqual(
    degradedReport.diagnostics.errors.map((item) => item.component),
    ['runtime_status', 'runtime_hotspots', 'low_resource', 'provider_request']
  );
  assert.ok(buildMainReplyLagDiagnosticText(degradedReport).includes('provider-request: scenarios=0 anomalies=1'));

  console.log('mainReplyLagDiagnostics.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

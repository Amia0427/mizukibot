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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-runtime-hotspots-'));
  const dataDir = path.join(tempDir, 'data');
  const resourceFile = path.join(dataDir, 'resource-snapshots.jsonl');
  const perfFile = path.join(dataDir, 'perf-events.jsonl');
  const now = Date.parse('2026-05-03T00:30:00.000Z');

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = dataDir;
    process.env.RESOURCE_SNAPSHOT_FILE = resourceFile;
    process.env.PERF_LOG_FILE = perfFile;
    process.env.RESOURCE_PRESSURE_ENABLED = 'true';
    process.env.RESOURCE_PRESSURE_HEAP_USED_MB = '100';
    process.env.RESOURCE_PRESSURE_RSS_MB = '150';
    process.env.RESOURCE_PRESSURE_EVENT_LOOP_MS = '50';
    process.env.RUNTIME_HOTSPOT_TIMER_WARNING_COUNT = '10';
    process.env.RUNTIME_HOTSPOT_INTERVAL_WARNING_COUNT = '3';
    process.env.POST_REPLY_WORKER_ENABLED = 'true';
    process.env.POST_REPLY_WORKER_INLINE = 'false';
    process.env.SUBAGENT_ENABLED = 'true';
    process.env.SUBAGENT_BACKEND = 'command';
    process.env.SUBAGENT_MAX_CONCURRENCY = '1';
    clearProjectCache();

    appendJsonLine(resourceFile, {
      recordedAt: '2026-05-03T00:10:00.000Z',
      processId: 111,
      component: 'main_process',
      rss: 160 * 1024 * 1024,
      heapTotal: 120 * 1024 * 1024,
      heapUsed: 110 * 1024 * 1024,
      eventLoopMeanMs: 12,
      eventLoopMaxMs: 80,
      activeTimers: 60,
      activeIntervals: 12,
      pressureLevel: 'pressured',
      pressureReasons: ['rss:160MB', 'heap:110MB']
    });
    appendJsonLine(resourceFile, {
      recordedAt: '2026-05-03T00:15:00.000Z',
      processId: 222,
      component: 'post_reply_worker',
      rss: 90 * 1024 * 1024,
      heapTotal: 80 * 1024 * 1024,
      heapUsed: 70 * 1024 * 1024,
      eventLoopMeanMs: 5,
      eventLoopMaxMs: 15,
      activeTimers: 2,
      activeIntervals: 1,
      postReplyActiveCount: 2,
      pressureLevel: 'normal',
      pressureReasons: []
    });
    appendJsonLine(perfFile, {
      recordedAt: '2026-05-03T00:16:00.000Z',
      category: 'background_pressure',
      type: 'memory_v3_materialize_deferred',
      module: 'memory_v3',
      delayMs: 15000
    });
    appendJsonLine(perfFile, {
      recordedAt: '2026-05-03T00:17:00.000Z',
      category: 'reply_event',
      type: 'planner_done',
      module: 'planner'
    });
    appendJsonLine(perfFile, {
      recordedAt: '2026-05-03T00:18:00.000Z',
      category: 'reply_event',
      type: 'planner_done',
      module: 'planner'
    });

    const { appendPerfEvent } = require('../utils/perfRuntime');
    appendPerfEvent({
      recordedAt: '2026-05-03T00:19:00.000Z',
      category: 'reply_event',
      type: 'planner_done',
      module: 'planner'
    });

    const { buildRuntimeHotspotsDiagnostic, buildRuntimeHotspotsText } = require('../utils/runtimeHotspotsDiagnostics');
    const report = buildRuntimeHotspotsDiagnostic({
      projectRoot: tempDir,
      now: () => now,
      windowMs: 30 * 60 * 1000,
      currentSnapshot: {
        recordedAt: '2026-05-03T00:30:00.000Z',
        processId: 999,
        component: 'diagnose_runtime_hotspots',
        rss: 155 * 1024 * 1024,
        heapTotal: 120 * 1024 * 1024,
        heapUsed: 105 * 1024 * 1024,
        eventLoopMeanMs: 20,
        eventLoopMaxMs: 55,
      activeTimers: 55,
      activeIntervals: 11,
        pressureLevel: 'pressured',
        pressureReasons: ['event_loop:55ms']
      },
      listProcesses: () => [
        { pid: 111, ppid: 1, name: 'node.exe', commandLine: 'node index.js' },
        { pid: 222, ppid: 1, name: 'node.exe', commandLine: 'node scripts/post-reply-worker.js' },
        { pid: 333, ppid: 222, name: 'node.exe', commandLine: 'node scripts/subagent-command-worker.js' },
        { pid: 334, ppid: 222, name: 'node.exe', commandLine: 'node scripts/subagent-command-worker.js' },
        { pid: 335, ppid: 222, name: 'node.exe', commandLine: 'node scripts/subagent-command-worker.js' }
      ],
      processResources: [
        { pid: 111, ppid: 1, name: 'node.exe', commandLine: 'node index.js', rss: 170 * 1024 * 1024 },
        { pid: 222, ppid: 1, name: 'node.exe', commandLine: 'node scripts/post-reply-worker.js', rss: 80 * 1024 * 1024 },
        { pid: 333, ppid: 222, name: 'node.exe', commandLine: 'node scripts/subagent-command-worker.js', rss: 75 * 1024 * 1024 },
        { pid: 334, ppid: 222, name: 'node.exe', commandLine: 'node scripts/subagent-command-worker.js', rss: 70 * 1024 * 1024 },
        { pid: 335, ppid: 222, name: 'node.exe', commandLine: 'node scripts/subagent-command-worker.js', rss: 65 * 1024 * 1024 },
        { pid: 336, ppid: 111, name: 'node.exe', commandLine: 'node scripts/backfill-memory-v3-embeddings.js --source all --limit 3000', rss: 240 * 1024 * 1024 },
        { pid: 337, ppid: 111, name: 'node.exe', commandLine: 'node scripts/local-mcp-server.js fetch', rss: 45 * 1024 * 1024 },
        { pid: 444, ppid: 1, name: 'node.exe', commandLine: 'C:/Program Files/nodejs/node.exe C:/Users/Administrator/openclaw/node_modules/openclaw/dist/index.js gateway --port 18789', rss: 330 * 1024 * 1024 }
      ],
      isProcessAlive: (pid) => [111, 222, 333, 334, 335].includes(Number(pid))
    });

    assert.strictEqual(report.schemaVersion, 'runtime_hotspots_diagnostic_v1');
    assert.strictEqual(report.summary.currentPressure, 'pressured');
    assert.strictEqual(report.summary.postReplyWorker.active.max, 2);
    assert.strictEqual(report.summary.subagents.processCount, 3);
    assert.strictEqual(report.summary.processRssMb.mainMax, 170);
    assert.strictEqual(report.processes.subagents.rssMb.total, 210);
    assert.strictEqual(report.summary.memoryBackfill.processCount, 1);
    assert.strictEqual(report.summary.memoryBackfill.rssMb.total, 240);
    assert.strictEqual(report.summary.localMcpChildren.processCount, 1);
    assert.strictEqual(report.summary.localMcpChildren.rssMb.total, 45);
    assert.ok(!report.processes.main.processes.some((item) => String(item.commandLine || '').includes('openclaw')));
    assert.ok(!report.processes.subagents.processes.some((item) => String(item.commandLine || '').includes('openclaw')));
    assert.ok(report.summary.topModules.some((item) => item.key === 'planner' && item.count === 3));
    assert.ok(report.inputs.resourceSnapshotFile.includesCurrentProcessSample);

    const signalCodes = report.signals.map((item) => item.code);
    assert.ok(signalCodes.includes('resource_pressure_active'));
    assert.ok(signalCodes.includes('rss_high_window'));
    assert.ok(signalCodes.includes('heap_high_window'));
    assert.ok(signalCodes.includes('event_loop_delay_high'));
    assert.ok(signalCodes.includes('active_timer_count_high'));
    assert.ok(signalCodes.includes('active_interval_count_high'));
    assert.ok(signalCodes.includes('background_pressure_deferred'));
    assert.ok(signalCodes.includes('subagent_process_count_high'));
    assert.ok(signalCodes.includes('process_rss_high'));

    const text = buildRuntimeHotspotsText(report);
    assert.ok(text.includes('runtime-hotspots:'));
    assert.ok(text.includes('memory-backfill:'));
    assert.ok(text.includes('local-mcp:'));
    assert.ok(text.includes('hot-modules:'));
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));

    console.log('runtimeHotspotsDiagnostics.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
})();

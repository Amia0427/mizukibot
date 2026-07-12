const assert = require('assert');
const os = require('os');
const path = require('path');

const config = require('../config');
const jsonHotStore = require('../utils/jsonHotStore');
const storeRegistry = require('../utils/storeRegistry');
const dailyShareStore = require('../core/dailyShareStore');

function createWriterProbe(calls) {
  return (filePath, options = {}) => {
    const meta = {
      filePath: path.resolve(String(filePath || '')),
      retentionManaged: options.retentionManaged === true
    };
    calls.push(meta);
    return {
      append() {},
      flushSync() {},
      getMeta() {
        return meta;
      }
    };
  };
}

function clearModule(relativePath) {
  delete require.cache[require.resolve(relativePath)];
}

module.exports = (async () => {
  const directWriterCalls = [];
  const registryWriterCalls = [];
  const originalDirectFactory = jsonHotStore.createJsonLineHotWriter;
  const originalRegistryFactory = storeRegistry.getJsonLineWriter;
  const originalDailyShareStore = {
    loadTargets: dailyShareStore.loadTargets,
    loadState: dailyShareStore.loadState,
    saveTargets: dailyShareStore.saveTargets,
    saveState: dailyShareStore.saveState
  };
  const configSnapshot = {
    PERF_LOG_ENABLED: config.PERF_LOG_ENABLED,
    RESOURCE_SNAPSHOT_ENABLED: config.RESOURCE_SNAPSHOT_ENABLED,
    PERF_LOG_FILE: config.PERF_LOG_FILE,
    RESOURCE_SNAPSHOT_FILE: config.RESOURCE_SNAPSHOT_FILE,
    BUFFERED_EVENT_LOG_ENABLED: config.BUFFERED_EVENT_LOG_ENABLED,
    DAILY_SHARE_EVENT_LOG_FILE: config.DAILY_SHARE_EVENT_LOG_FILE,
    ADMIN_USER_IDS: config.ADMIN_USER_IDS,
    MEMORY_V3_EVENTS_DIR: config.MEMORY_V3_EVENTS_DIR
  };
  const unique = `${process.pid}-${Date.now()}`;
  const paths = {
    perf: path.join(os.tmpdir(), `mizuki-perf-policy-${unique}.jsonl`),
    resource: path.join(os.tmpdir(), `mizuki-resource-policy-${unique}.jsonl`),
    timing: path.join(os.tmpdir(), `mizuki-timing-policy-${unique}.jsonl`),
    napcat: path.join(os.tmpdir(), `mizuki-napcat-policy-${unique}.jsonl`),
    dailyShare: path.join(os.tmpdir(), `mizuki-daily-share-policy-${unique}.jsonl`),
    helperState: path.join(os.tmpdir(), `mizuki-helper-state-${unique}.jsonl`),
    journalState: path.join(os.tmpdir(), `mizuki-journal-state-${unique}.jsonl`),
    improvementState: path.join(os.tmpdir(), `mizuki-improvement-state-${unique}.jsonl`)
  };

  try {
    jsonHotStore.createJsonLineHotWriter = createWriterProbe(directWriterCalls);
    storeRegistry.getJsonLineWriter = createWriterProbe(registryWriterCalls);
    dailyShareStore.loadTargets = () => ({});
    dailyShareStore.loadState = () => ({});
    dailyShareStore.saveTargets = () => {};
    dailyShareStore.saveState = () => {};

    config.PERF_LOG_ENABLED = true;
    config.RESOURCE_SNAPSHOT_ENABLED = true;
    config.PERF_LOG_FILE = paths.perf;
    config.RESOURCE_SNAPSHOT_FILE = paths.resource;
    config.BUFFERED_EVENT_LOG_ENABLED = true;
    config.DAILY_SHARE_EVENT_LOG_FILE = paths.dailyShare;
    config.ADMIN_USER_IDS = ['retention-policy-admin'];
    config.MEMORY_V3_EVENTS_DIR = os.tmpdir();

    clearModule('../utils/perfRuntime');
    const perfRuntime = require('../utils/perfRuntime');
    perfRuntime.appendPerfEvent({ type: 'retention-policy-test' });
    perfRuntime.appendResourceSnapshot({ type: 'retention-policy-test' });

    clearModule('../core/messageTelemetry');
    require('../core/messageTelemetry').appendInboundTimingLog(paths.timing, true, {
      phase: 'retention-policy-test'
    });

    clearModule('../core/napcatLogFollower');
    require('../core/napcatLogFollower').appendNapcatPacketToLog({
      post_type: 'message',
      message_type: 'private',
      message_id: 'retention-policy-test',
      user_id: 'retention-policy-user',
      raw_message: 'test'
    }, {
      enabled: true,
      logPath: paths.napcat
    });

    clearModule('../utils/memory-v3/events');
    await require('../utils/memory-v3/events').appendMemoryEvent({
      type: 'turn_received',
      ts: Date.now(),
      userId: 'retention-policy-user',
      text: 'test'
    });
    clearModule('../utils/memory-v3/helpers');
    require('../utils/memory-v3/helpers').appendLine(paths.helperState, 'test');
    clearModule('../utils/dailyJournal/jsonLines');
    require('../utils/dailyJournal/jsonLines').appendJsonLine(paths.journalState, { test: true });
    clearModule('../utils/selfImprovement/storeFiles');
    require('../utils/selfImprovement/storeFiles').appendJsonLine(paths.improvementState, { test: true });

    clearModule('../src/features/daily-share');
    clearModule('../core/dailyShareEngine');
    const dailyShareEngine = require('../src/features/daily-share').createDailyShareEngine();
    const commandResult = await dailyShareEngine.handleAdminCommand({
      rawText: '/dailyshare status',
      groupId: 'retention-policy-group',
      userId: 'retention-policy-admin',
      date: new Date('2026-07-13T04:00:00+08:00')
    });
    assert.strictEqual(commandResult.handled, true);
    assert.match(commandResult.replyText, /已发 0\/1/);
    const qzoneCommandResult = await dailyShareEngine.handleAdminCommand({
      rawText: '/dailyshare qzone status',
      groupId: 'retention-policy-group',
      userId: 'retention-policy-admin',
      date: new Date('2026-07-13T04:00:00+08:00')
    });
    assert.strictEqual(qzoneCommandResult.handled, true);
    assert.match(qzoneCommandResult.replyText, /已发 0\/2/);

    const directByPath = new Map(directWriterCalls.map((item) => [item.filePath, item]));
    for (const filePath of [paths.perf, paths.resource, paths.timing, paths.napcat]) {
      assert.strictEqual(directByPath.get(path.resolve(filePath))?.retentionManaged, true, filePath);
    }

    const statePaths = [paths.helperState, paths.journalState, paths.improvementState];
    for (const filePath of statePaths) {
      const call = registryWriterCalls.find((item) => item.filePath === path.resolve(filePath));
      assert.strictEqual(call?.retentionManaged, false, filePath);
    }
    const memoryEventCall = registryWriterCalls.find((item) => /\d{4}-\d{2}-\d{2}\.ndjson$/i.test(item.filePath));
    assert.strictEqual(memoryEventCall?.retentionManaged, false);
    const dailyShareCalls = registryWriterCalls.filter((item) => item.filePath === path.resolve(paths.dailyShare));
    assert.ok(dailyShareCalls.length > 0, 'daily share status should generate schedule telemetry');
    assert.ok(dailyShareCalls.every((item) => item.retentionManaged));

    console.log('logRetentionCallsites.test.js passed');
  } finally {
    jsonHotStore.createJsonLineHotWriter = originalDirectFactory;
    storeRegistry.getJsonLineWriter = originalRegistryFactory;
    Object.assign(dailyShareStore, originalDailyShareStore);
    Object.assign(config, configSnapshot);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

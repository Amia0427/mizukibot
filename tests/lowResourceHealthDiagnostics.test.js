const assert = require('assert');

const {
  buildLowResourceHealthReport,
  buildLowResourceHealthText
} = require('../scripts/diagnose-low-resource');
const config = require('../config');

const report = buildLowResourceHealthReport({
  status: {
    summary: {
      postReplyWorker: {
        status: 'running',
        pid: 222,
        processCount: 1,
        pidFileMatch: true,
        queue: { queued: 0, processing: 0, failed: 0 }
      }
    }
  },
  hotspots: {
    summary: {
      localMcpChildren: {
        processCount: 0,
        rssMb: { total: 0, max: 0 }
      },
      memoryBackfill: {
        processCount: 0,
        rssMb: { total: 0, max: 0 }
      }
    }
  }
});

assert.strictEqual(report.schemaVersion, 'low_resource_health_v1');
assert.strictEqual(report.ok, true);
assert.strictEqual(report.summary.postReplyWorker.pidFileMatch, true);
assert.ok(report.summary.config && typeof report.summary.config === 'object');
assert.ok(buildLowResourceHealthText(report).includes('config: lowResource='));

const warning = buildLowResourceHealthReport({
  status: {
    summary: {
      postReplyWorker: {
        status: 'running',
        pidFileMatch: false,
        queue: {}
      }
    }
  },
  hotspots: {
    summary: {
      localMcpChildren: { processCount: 1, rssMb: { total: 50, max: 50 } },
      memoryBackfill: { processCount: 1, rssMb: { total: 400, max: 400 } }
    }
  }
});

assert.strictEqual(warning.ok, false);
assert.ok(warning.failedChecks.includes('localMcpIdle'));
assert.ok(warning.failedChecks.includes('memoryBackfillWithinLimit'));
assert.ok(warning.failedChecks.includes('postReplyPidHealthy'));
assert.ok(buildLowResourceHealthText(warning).includes('low-resource-health: warning'));

const previousIdleRecycleEnabled = config.POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED;
const previousWorkerEnabled = config.POST_REPLY_WORKER_ENABLED;
const previousRssRecycleMb = config.POST_REPLY_WORKER_RSS_RECYCLE_MB;
try {
  config.POST_REPLY_WORKER_ENABLED = true;
  config.POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED = false;
  config.POST_REPLY_WORKER_RSS_RECYCLE_MB = 512;

  const missingWorker = buildLowResourceHealthReport({
    status: {
      summary: {
        postReplyWorker: {
          status: 'missing',
          processCount: 0,
          pidFileMatch: true,
          queue: {}
        }
      }
    },
    hotspots: {
      summary: {
        localMcpChildren: { processCount: 0, rssMb: { total: 0, max: 0 } },
        memoryBackfill: { processCount: 0, rssMb: { total: 0, max: 0 } }
      }
    }
  });

  assert.strictEqual(missingWorker.ok, false);
  assert.strictEqual(missingWorker.summary.config.postReplyIdleRecycled, false);
  assert.ok(missingWorker.failedChecks.includes('postReplyRunning'));

  config.POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED = true;
  const recycled = buildLowResourceHealthReport({
    status: {
      summary: {
        postReplyWorker: {
          status: 'missing',
          processCount: 0,
          pidFileMatch: true,
          queue: {}
        }
      }
    },
    hotspots: {
      summary: {
        localMcpChildren: { processCount: 0, rssMb: { total: 0, max: 0 } },
        memoryBackfill: { processCount: 0, rssMb: { total: 0, max: 0 } }
      }
    }
  });

  assert.strictEqual(recycled.ok, true);
  assert.strictEqual(recycled.summary.config.postReplyIdleRecycled, true);
  assert.ok(buildLowResourceHealthText(recycled).includes('idleRecycled=true'));
} finally {
  config.POST_REPLY_WORKER_IDLE_RECYCLE_ENABLED = previousIdleRecycleEnabled;
  config.POST_REPLY_WORKER_ENABLED = previousWorkerEnabled;
  config.POST_REPLY_WORKER_RSS_RECYCLE_MB = previousRssRecycleMb;
}

console.log('lowResourceHealthDiagnostics.test.js passed');

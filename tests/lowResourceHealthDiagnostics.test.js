const assert = require('assert');

const {
  buildLowResourceHealthReport,
  buildLowResourceHealthText
} = require('../scripts/diagnose-low-resource');

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

console.log('lowResourceHealthDiagnostics.test.js passed');

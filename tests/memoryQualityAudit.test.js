const assert = require('assert');

function clearProjectCache() {
  const projectRoot = require('path').resolve(__dirname, '..') + require('path').sep;
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

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    process.env.API_KEY = 'test-key';
    process.env.MEMORY_API_BASE_URL = 'https://example.com/v1';
    process.env.MEMORY_API_KEY = 'real-test-key';
    process.env.MEMORY_MODEL = 'memory-audit-test';
    process.env.POST_REPLY_MEMORY_QUALITY_AUDIT_ENABLED = 'true';
    clearProjectCache();

    const {
      buildHardMetricWarnings,
      resetMemoryQualityAuditState,
      runMemoryQualityAudit
    } = require('../utils/memoryQualityAudit');

    const hardMetricsOk = {
      syncSummary: {
        ok: true,
        syncEnabled: true,
        coverage: {
          memory: { readyButNotSynced: 0, staleTableRows: 0, failedRows: 0, pendingRows: 0 },
          worldbook: { readyButNotSynced: 0, staleTableRows: 0, failedRows: 0, pendingRows: 0 }
        }
      },
      projectionFreshness: {
        projectionStale: false,
        usedOldSnapshot: false,
        materializeLock: { stale: false }
      }
    };
    const sampleNodes = [{
      id: 'node-1',
      userId: 'u1',
      scopeType: 'personal',
      status: 'active',
      memoryKind: 'preference',
      semanticSlot: 'preference_like',
      text: '用户喜欢草莓蛋糕',
      confidence: 0.91,
      evidenceCount: 2,
      updatedAt: 100
    }];
    const sampleCases = [{
      id: 'case-1',
      userId: 'u1',
      query: '我喜欢什么甜点',
      facet: 'preference'
    }];
    const queryResult = {
      results: [{
        id: 'node-1',
        userId: 'u1',
        scopeType: 'personal',
        source: 'memory',
        memoryKind: 'preference',
        semanticSlot: 'preference_like',
        text: '用户喜欢草莓蛋糕',
        score: 0.95
      }],
      stats: {
        lancedb: {}
      }
    };

    resetMemoryQualityAuditState();
    let postedBody = null;
    const valid = await runMemoryQualityAudit({
      enabled: true,
      force: true,
      sampleSize: 5,
      intervalMs: 0,
      apiKey: 'real-test-key'
    }, {
      buildSyncSummary: async () => hardMetricsOk.syncSummary,
      diagnoseProjectionFreshness: () => hardMetricsOk.projectionFreshness,
      loadMemoryNodes: () => sampleNodes,
      loadCases: () => sampleCases,
      queryMemory: async () => queryResult,
      postWithRetry: async (_url, body) => {
        postedBody = body;
        return {
          data: {
            choices: [{
              message: {
                content: JSON.stringify({
                  score: 0.82,
                  writeFindings: [{
                    nodeId: 'node-1',
                    severity: 'medium',
                    type: 'over_summary',
                    reason: 'source evidence is thin',
                    recommendation: 'keep as candidate until more evidence'
                  }],
                  recallFindings: [{
                    caseId: 'case-1',
                    resultId: 'node-1',
                    verdict: 'weak',
                    severity: 'low',
                    reason: 'top result is relevant but lacks direct dessert wording'
                  }],
                  warnings: [{
                    code: 'semantic_note',
                    severity: 'low',
                    message: 'sample is small'
                  }]
                })
              }
            }]
          }
        };
      }
    });
    assert.strictEqual(valid.ok, false, 'medium finding should lower audit ok below the pass threshold');
    assert.strictEqual(valid.writeFindings.length, 1);
    assert.strictEqual(valid.writeFindings[0].type, 'over_summary');
    assert.strictEqual(valid.recallFindings.length, 1);
    assert.strictEqual(valid.recallFindings[0].verdict, 'weak');
    assert.ok(postedBody.messages[1].content.includes('用户喜欢草莓蛋糕'), 'audit prompt should include sampled memory evidence');

    resetMemoryQualityAuditState();
    const invalidJson = await runMemoryQualityAudit({
      enabled: true,
      force: true,
      sampleSize: 5,
      intervalMs: 0,
      apiKey: 'real-test-key'
    }, {
      buildSyncSummary: async () => hardMetricsOk.syncSummary,
      diagnoseProjectionFreshness: () => hardMetricsOk.projectionFreshness,
      loadMemoryNodes: () => sampleNodes,
      loadCases: () => sampleCases,
      queryMemory: async () => queryResult,
      postWithRetry: async () => ({
        data: {
          choices: [{
            message: {
              content: 'not json'
            }
          }]
        }
      })
    });
    assert.strictEqual(invalidJson.ok, true, 'invalid semantic JSON should degrade to warning only');
    assert.ok(invalidJson.warnings.some((item) => item.code === 'semantic_audit_invalid_json'));
    assert.strictEqual(invalidJson.writeFindings.length, 0);

    resetMemoryQualityAuditState();
    const timeout = await runMemoryQualityAudit({
      enabled: true,
      force: true,
      sampleSize: 5,
      intervalMs: 0,
      apiKey: 'real-test-key'
    }, {
      buildSyncSummary: async () => hardMetricsOk.syncSummary,
      diagnoseProjectionFreshness: () => hardMetricsOk.projectionFreshness,
      loadMemoryNodes: () => sampleNodes,
      loadCases: () => sampleCases,
      queryMemory: async () => queryResult,
      postWithRetry: async () => {
        throw new Error('timeout');
      }
    });
    assert.strictEqual(timeout.ok, true, 'model timeout should not fail the audit');
    assert.ok(timeout.warnings.some((item) => item.code === 'semantic_audit_failed'));

    const driftWarnings = buildHardMetricWarnings({
      syncSummary: {
        ok: true,
        coverage: {
          memory: { readyButNotSynced: 2, staleTableRows: 1, failedRows: 0, pendingRows: 0 },
          worldbook: { readyButNotSynced: 0, staleTableRows: 0, failedRows: 1, pendingRows: 0 }
        }
      },
      projectionFreshness: {
        projectionStale: true,
        projectionStaleReason: 'event_newer_than_projection',
        materializeLock: { stale: false }
      }
    });
    assert.strictEqual(driftWarnings[0].code, 'vector_coverage_drift', 'hard metric drift warning should be first');
    assert.strictEqual(driftWarnings[0].severity, 'high');
    assert.ok(driftWarnings.some((item) => item.code === 'projection_stale'));

    console.log('memoryQualityAudit.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

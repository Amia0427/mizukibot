const assert = require('assert');

const { buildLongTermMemoryQualityReport } = require('../utils/memoryQualitySources');

const report = buildLongTermMemoryQualityReport({ limit: 10 }, {
  loadMemoryNodes: () => [{
    id: 'm1',
    userId: 'u_quality_sources',
    type: 'fact',
    text: 'system prompt should be remembered',
    status: 'active',
    confidence: 0.95,
    sourceKind: 'extractor'
  }],
  loadPersonaModuleCatalog: () => ({
    modules: [{ id: 'wb_ok', path: 'persona_worldbook/wb_ok.md', purpose: 'Stable persona module', priority: 1 }]
  }),
  buildWorldbookDocuments: () => [{
    moduleId: 'wb_ok',
    purpose: 'Stable persona module',
    text: 'Use stable tone information only.',
    fileMtimeMs: Date.now()
  }],
  readSocialStore: () => ({
    groups: {
      g1: {
        summary: { sampleCount: 30, atmosphere: 'calm' },
        updatedAt: Date.now()
      }
    },
    mergedGraph: { edges: {} }
  }),
  listAllAssets: () => [{
    id: 'img_1',
    enabled: true,
    name: 'smile image',
    analysis: { status: 'ready', caption: 'friendly smile', keywords: ['smile'] }
  }],
  listNotebookDocs: () => [{
    id: 'doc_1',
    userId: 'u_quality_sources',
    title: 'Notebook',
    content: 'Project memory note'
  }]
});

assert.strictEqual(report.ok, true);
assert.ok(report.bySource.memory_v3.polluted >= 1);
assert.ok(report.bySource.worldbook.scanned >= 1);
assert.ok(report.bySource.social_context.scanned >= 1);
assert.ok(report.bySource.image_assets.scanned >= 1);
assert.ok(report.bySource.notebook.scanned >= 1);
assert.ok(report.scanned >= 5);

console.log('memoryQualitySources.test.js passed');

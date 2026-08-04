const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMaimaiCatalogStore } = require('../src/features/maimai/catalog-store');

module.exports = (() => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-maimai-catalog-'));
  const dbFile = path.join(tempRoot, 'catalog.sqlite');
  const store = createMaimaiCatalogStore({ dbFile });

  try {
    const runId = store.startSync({ musicEtag: 'music-v1', statsEtag: 'stats-v1', sourceRevision: 'source-v1' });
    store.replaceGeneration(runId, {
      songs: [{ musicId: '1001', title: 'Test Song', normalizedTitle: 'testsong', chartType: 'SD', artist: 'Artist', bpm: 120 }],
      charts: [{
        chartKey: 'df:1001:SD:3',
        musicId: '1001',
        chartType: 'SD',
        difficultyIndex: 3,
        difficultyName: 'Master',
        level: '12',
        constant: 12.4,
        noteTotal: 11,
        charter: 'Mapper',
        statsAvg: 98,
        statsStdDev: 2
      }],
      sources: [{ contentHash: 'hash-1', rawChart: '(120){4}1,E', parseStatus: 'ok' }],
      mappings: [{
        sourceChartKey: 'source:1001:3',
        chartKey: 'df:1001:SD:3',
        contentHash: 'hash-1',
        status: 'confirmed',
        confidence: 1,
        reason: 'fixture'
      }],
      features: [{
        contentHash: 'hash-1',
        featureAlgorithmVersion: 'maimai_features_v1',
        duration: 10,
        noteCounts: { tap: 8, touch: 0, hold: 1, slide: 1, break: 1 },
        density: 1.1,
        peakDensity: 2,
        chordCount: 1,
        interactionCount: 2,
        verticalStreamCount: 3,
        slideComboCount: 1,
        bpmChangeCount: 0,
        bpmMin: 120,
        bpmMax: 120,
        techniqueTags: ['纵连', '滑键组合']
      }],
      events: [{
        contentHash: 'hash-1',
        eventIndex: 0,
        type: 'tap',
        time: 0,
        duration: 0,
        location: '0:0',
        collectionSize: 1
      }],
      segments: [{
        contentHash: 'hash-1',
        segmentIndex: 0,
        startTime: 0,
        endTime: 8,
        intensity: 2,
        rawText: '(120){4}1,E',
        templateText: '纵连和滑键组合明显',
        polishedText: '纵连与滑键组合较集中',
        documentHash: 'doc-1'
      }]
    });
    store.activateGeneration(runId, {
      vectorTable: 'maimai_chart_segments_fixture',
      parsedRatio: 1,
      mappingCoverage: 1,
      documentCount: 2,
      vectorCount: 2
    });

    const active = store.getActiveGeneration();
    assert.strictEqual(active.id, runId);
    assert.strictEqual(active.vectorTable, 'maimai_chart_segments_fixture');

    const rows = store.searchCharts({ query: 'Test Song 纵连', limit: 10 });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].chartKey, 'df:1001:SD:3');
    assert.deepStrictEqual(rows[0].techniqueTags, ['纵连', '滑键组合']);
    assert.strictEqual(store.searchCharts({ query: 'Test Song', chart_type: 'SD' }).length, 1);
    assert.strictEqual(store.searchCharts({ query: 'Test Song', chart_type: 'DX' }).length, 0);

    const detail = store.getChartAnalysis({ title: 'test song', chart_type: 'SD', difficulty: 'master' });
    assert.strictEqual(detail.status, 'ok');
    assert.strictEqual(detail.chart.chartKey, 'df:1001:SD:3');
    assert.strictEqual(detail.segments.length, 1);
    assert.strictEqual(store.getChartAnalysis({ title: 'test song', chart_type: 'DX' }).status, 'ambiguous');
    assert.strictEqual(store.db.prepare('SELECT COUNT(*) FROM maimai_chart_events').pluck().get(), 1);

    store.setSummaryCache('hash-1:prompt-v1:model-v1', {
      contentHash: 'hash-1',
      promptVersion: 'prompt-v1',
      modelVersion: 'model-v1',
      value: { chartKey: 'df:1001:SD:3', text: 'cached' }
    });
    assert.strictEqual(store.getSummaryCache('hash-1:prompt-v1:model-v1').text, 'cached');
    assert.strictEqual(store.getLastSuccessfulSync().id, runId);

    const failedRun = store.startSync({ sourceRevision: 'source-v2' });
    store.failSync(failedRun, 'embedding failed');
    assert.strictEqual(store.getActiveGeneration().id, runId);

    console.log('maimaiCatalogStore.test.js passed');
  } finally {
    store.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})();

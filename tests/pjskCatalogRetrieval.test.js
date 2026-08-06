const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPjskCatalogStore } = require('../src/features/pjsk/catalog-store');
const { createPjskRetrievalService } = require('../src/features/pjsk/retrieval-service');

function feature(contentHash, overrides = {}) {
  return {
    contentHash,
    featureAlgorithmVersion: 'pjsk-usc-v1',
    duration: 100,
    noteTotal: 100,
    noteCounts: { tap: 50, flick: 10, slide: 10, trace: 5, critical: 4 },
    chordCount: 10,
    wideNoteCount: 3,
    maxChordSize: 2,
    maxChordSpan: 4,
    slideDuration: 20,
    bpmChangeCount: 0,
    timeScaleChangeCount: 0,
    bpmMin: 120,
    bpmMax: 120,
    density: 1,
    peakDensity: 3,
    techniqueTags: ['多押偏多'],
    ...overrides
  };
}

function payload(nowMs) {
  return {
    songs: [
      { musicId: 1, title: 'ロキ', pronunciation: 'ろき', lyricist: 'みきとP', composer: 'みきとP', arranger: '', assetbundleName: 'jacket_s_001', publishedAt: nowMs - 1000 },
      { musicId: 2, title: 'Future Song', pronunciation: '', lyricist: '', composer: 'A', arranger: '', assetbundleName: 'jacket_s_002', publishedAt: nowMs + 100000 },
      { musicId: 3, title: 'Broken Song', pronunciation: '', lyricist: '', composer: 'B', arranger: '', assetbundleName: 'jacket_s_003', publishedAt: nowMs - 1000 },
      { musicId: 4, title: 'ロキ', pronunciation: '', lyricist: '', composer: 'C', arranger: '', assetbundleName: 'jacket_s_004', publishedAt: nowMs - 1000 }
    ],
    aliases: [
      { musicId: 1, locale: 'ja', alias: 'ロキ', kind: 'canonical' },
      { musicId: 1, locale: 'zh-CN', alias: '洛基', kind: 'localized' },
      { musicId: 2, locale: 'en', alias: 'Future Song', kind: 'canonical' },
      { musicId: 3, locale: 'en', alias: 'Broken Song', kind: 'canonical' },
      { musicId: 4, locale: 'ja', alias: 'ロキ', kind: 'canonical' }
    ],
    tags: [{ musicId: 1, tag: 'vocaloid' }],
    singingVersions: [{
      vocalId: 1,
      musicId: 1,
      vocalType: 'sekai',
      caption: 'セカイver.',
      assetbundleName: '0001_01',
      characters: [{ characterId: 1, name: '星乃一歌', firstNameEnglish: 'HOSHINO', givenNameEnglish: 'ICHIKA', unit: 'light_sound' }]
    }],
    characters: [{ characterId: 1, name: '星乃一歌', firstNameEnglish: 'HOSHINO', givenNameEnglish: 'ICHIKA', unit: 'light_sound' }],
    charts: [
      { chartKey: 'jp:1:master', musicId: 1, difficulty: 'master', level: 28, noteTotal: 100, contentHash: 'hash-1', parseStatus: 'ok', featureAlgorithmVersion: 'pjsk-usc-v1' },
      { chartKey: 'jp:2:master', musicId: 2, difficulty: 'master', level: 30, noteTotal: 100, contentHash: 'hash-2', parseStatus: 'ok', featureAlgorithmVersion: 'pjsk-usc-v1' },
      { chartKey: 'jp:3:master', musicId: 3, difficulty: 'master', level: 31, noteTotal: 100, contentHash: 'hash-3', parseStatus: 'failed', parseError: 'parse failed' },
      { chartKey: 'jp:4:master', musicId: 4, difficulty: 'master', level: 29, noteTotal: 100, contentHash: 'hash-4', parseStatus: 'ok', featureAlgorithmVersion: 'pjsk-usc-v1' }
    ],
    sources: [
      { chartKey: 'jp:1:master', contentHash: 'hash-1', rawSus: 'sus1', sourceUrl: 'https://example/1', parseStatus: 'ok' },
      { chartKey: 'jp:2:master', contentHash: 'hash-2', rawSus: 'sus2', sourceUrl: 'https://example/2', parseStatus: 'ok' },
      { chartKey: 'jp:3:master', contentHash: 'hash-3', rawSus: 'sus3', sourceUrl: 'https://example/3', parseStatus: 'failed', parseError: 'parse failed' },
      { chartKey: 'jp:4:master', contentHash: 'hash-4', rawSus: 'sus4', sourceUrl: 'https://example/4', parseStatus: 'ok' }
    ],
    features: [feature('hash-1'), feature('hash-2'), feature('hash-4')],
    segments: [{ contentHash: 'hash-1', segmentIndex: 0, startTime: 10, endTime: 18, intensity: 20, summaryText: 'dense', documentHash: 'doc-1' }]
  };
}

module.exports = (async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pjsk-catalog-'));
  const nowMs = Date.now();
  const catalog = createPjskCatalogStore({ dbFile: path.join(tempDir, 'catalog.sqlite'), now: () => new Date(nowMs) });
  const runId = catalog.startSync({ sourceRevision: 'rev-1' });
  catalog.replaceGeneration(runId, payload(nowMs));
  catalog.activateSqlGeneration(runId, { parsedRatio: 1, noteVerificationCoverage: 1 });
  try {
    const localizedResult = catalog.searchCharts({ query: '洛基', difficulty: 'master' });
    assert.deepStrictEqual(localizedResult.map((row) => row.chartKey), ['jp:1:master']);
    assert.deepStrictEqual(localizedResult[0].aliases.map((alias) => alias.alias), ['ロキ', '洛基']);
    assert.deepStrictEqual(localizedResult[0].tags, ['vocaloid']);
    assert.strictEqual(localizedResult[0].singingVersions[0].caption, 'セカイver.');
    assert.deepStrictEqual(catalog.searchCharts({ query: 'PJSK 查洛基 MASTER 谱' }).map((row) => row.chartKey), ['jp:1:master']);
    assert.deepStrictEqual(catalog.searchCharts({ query: '星乃一歌' }).map((row) => row.chartKey), ['jp:1:master']);
    assert.deepStrictEqual(catalog.searchCharts({ query: '不存在的曲名' }), []);
    assert.strictEqual(catalog.searchCharts({ query: 'Future Song' }).length, 0);
    const detail = catalog.getChartAnalysis({ title: '洛基', difficulty: 'master' });
    assert.strictEqual(detail.status, 'ok');
    assert.strictEqual(detail.segments.length, 1);
    assert.strictEqual(detail.chart.singingVersions[0].characters[0].name, '星乃一歌');
    assert.strictEqual(catalog.getChartAnalysis({ title: 'Broken Song', difficulty: 'master' }).status, 'unavailable');
    assert.strictEqual(catalog.getChartAnalysis({ title: 'ロキ', difficulty: 'master' }).status, 'ambiguous');

    let vectorCalls = 0;
    const vectorIndex = {
      searchText: async (_, options) => {
        vectorCalls += 1;
        assert.deepStrictEqual(options.candidateContentHashes, ['hash-1']);
        return { ok: true, rows: [{ contentHash: 'rogue', _distance: 0 }, { contentHash: 'hash-1', _distance: 0.2 }] };
      }
    };
    const retrieval = createPjskRetrievalService({ catalog, vectorIndex });
    const sqlOnly = await retrieval.searchSongs({ query: '洛基' });
    assert.strictEqual(sqlOnly.evidence.retrievalMode, 'sql_only');
    assert.strictEqual(vectorCalls, 0);

    catalog.markVectorReady(runId, { vectorTable: 'pjsk_g1', documentCount: 1, vectorCount: 1 });
    const hybrid = await retrieval.searchSongs({ query: '洛基' });
    assert.strictEqual(hybrid.evidence.retrievalMode, 'hybrid');
    assert.deepStrictEqual(hybrid.results.map((row) => row.chartKey), ['jp:1:master']);
    assert.strictEqual(vectorCalls, 1);
  } finally {
    catalog.close();
  }
  console.log('pjskCatalogRetrieval.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

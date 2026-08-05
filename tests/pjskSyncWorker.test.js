const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPjskCatalogStore } = require('../src/features/pjsk/catalog-store');
const { MASTER_FILES } = require('../src/features/pjsk/source-client');
const { createPjskSyncWorker } = require('../src/features/pjsk/sync-worker');

function masters(title = 'Test Song') {
  return {
    jpMusics: [{ id: 1, title, pronunciation: '', lyricist: 'Writer', composer: 'Composer', arranger: '', assetbundleName: 'jacket_s_001', publishedAt: 1 }],
    jpDifficulties: [{ musicId: 1, musicDifficulty: 'master', playLevel: 30, totalNoteCount: 10 }],
    jpVocals: [],
    jpTags: [],
    jpCharacters: [],
    cnMusics: [{ id: 1, title: '测试歌曲', infos: [{ title: 'Test Song' }] }]
  };
}

function masterResponse(data, unchanged = false) {
  const files = {};
  for (const [name, base, file] of MASTER_FILES) {
    files[name] = unchanged
      ? { unchanged: true, etag: `etag-${name}`, url: `${base}/${file}` }
      : { unchanged: false, etag: `etag-${name}`, hash: `hash-${name}-${data.jpMusics[0].title}`, text: JSON.stringify(data[name]), url: `${base}/${file}` };
  }
  return { unchanged, files, etags: Object.fromEntries(MASTER_FILES.map(([name]) => [name, `etag-${name}`])) };
}

function analysis(noteTotal) {
  return {
    featureAlgorithmVersion: 'pjsk-usc-v1',
    duration: 10,
    noteTotal,
    noteCounts: { tap: 8, flick: 1, slide: 1, trace: 0, critical: 0 },
    chordCount: 1,
    wideNoteCount: 0,
    maxChordSize: 2,
    maxChordSpan: 2,
    slideDuration: 1,
    bpmChangeCount: 0,
    timeScaleChangeCount: 0,
    bpmMin: 120,
    bpmMax: 120,
    density: 1,
    peakDensity: 2,
    techniqueTags: [],
    segments: [{ segmentIndex: 0, startTime: 0, endTime: 8, intensity: 10, rawText: 'segment' }]
  };
}

module.exports = (async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pjsk-sync-'));
  const catalog = createPjskCatalogStore({ dbFile: path.join(tempDir, 'catalog.sqlite') });
  let mode = 'first';
  let parsedNoteTotal = 10;
  const sourceClient = {
    fetchMaster: async () => masterResponse(masters(mode === 'mismatch' ? 'Changed Song' : 'Test Song'), mode === 'noop'),
    fetchSusBatch: async () => [{ chartKey: 'jp:1:master', rawSus: 'trusted sus', contentHash: 'content-1', etag: 'sus-etag', sourceUrl: 'https://storage.example/master.txt' }]
  };
  const vectorIndex = { writeDocuments: async () => ({ ok: false, reason: 'embedding_unavailable', vectorCount: 0 }) };
  const worker = createPjskSyncWorker({ catalog, sourceClient, vectorIndex, analyzeChart: async () => analysis(parsedNoteTotal) });
  try {
    const first = await worker.runOnce();
    assert.strictEqual(first.status, 'active_sql_only');
    const activeId = catalog.getActiveGeneration().id;
    assert.strictEqual(catalog.searchCharts({ query: '测试歌曲' })[0].title, 'Test Song');

    mode = 'noop';
    const noop = await worker.runOnce();
    assert.strictEqual(noop.status, 'no_op');
    assert.strictEqual(catalog.getActiveGeneration().id, activeId);

    mode = 'mismatch';
    parsedNoteTotal = 9;
    const mismatch = await worker.runOnce();
    assert.strictEqual(mismatch.status, 'failed');
    assert.match(mismatch.error, /verification coverage/);
    assert.strictEqual(catalog.getActiveGeneration().id, activeId);
    assert.strictEqual(catalog.searchCharts({ query: '测试歌曲' })[0].title, 'Test Song');
  } finally {
    catalog.close();
  }
  console.log('pjskSyncWorker.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

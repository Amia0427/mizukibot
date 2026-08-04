const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMaimaiCatalogStore } = require('../src/features/maimai/catalog-store');
const { createMaimaiSyncWorker } = require('../src/features/maimai/sync-worker');

module.exports = (async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-maimai-sync-'));
  const catalog = createMaimaiCatalogStore({ dbFile: path.join(tempRoot, 'catalog.sqlite') });
  let fetchCount = 0;
  const raw = '&title=Test Song\n&shortid=1001\n&artist=Artist\n&wholebpm=120\n&cabinet=SD\n&lv_1=12\n&inote_1=\n(120){4}1,2,3,E\n&lv_2=13\n&inote_2=\n(120){4}1,2,3,4,E';
  const sourceClient = {
    async fetchAll(state) {
      fetchCount += 1;
      return {
        music: { unchanged: false, etag: 'm1', songs: [{
          id: '1001', title: 'Test Song', type: 'SD', ds: [12, 13], level: ['12', '13'], charts: [
            { notes: [1, 1, 1, 0], charter: 'Mapper' },
            { notes: [2, 1, 1, 0], charter: 'Mapper' }
          ], basic_info: { artist: 'Artist', bpm: 120 }
        }] },
        stats: { unchanged: false, etag: 's1', charts: { '1001': [
          { level_index: 0, avg: 98, std_dev: 2 },
          { level_index: 1, avg: 97, std_dev: 3 }
        ] } },
        maidata: { sourceRevision: 'tree-1', currentTree: { 'songs/1001/maidata.txt': 'blob-1' }, changed: [{ path: 'songs/1001/maidata.txt', sha: 'blob-1', content: raw }], removed: [], noop: false }
      };
    }
  };
  const vectorIndex = {
    writtenDocuments: [],
    async writeDocuments(documents, options) {
      this.writtenDocuments = documents;
      return { ok: true, tableName: `vectors-g${options.generationId}`, vectorCount: documents.length };
    }
  };
  const summaryGenerator = { async generate(charts) { return charts.map((chart) => ({ chartKey: chart.chartKey, text: 'summary', segments: chart.segments.map((segment) => ({ segmentIndex: segment.segmentIndex, text: 'segment' })) })); } };
  try {
    const worker = createMaimaiSyncWorker({ catalog, sourceClient, vectorIndex, summaryGenerator });
    const result = await worker.runOnce();
    assert.strictEqual(result.status, 'active', JSON.stringify(result));
    assert.strictEqual(result.parsedRatio, 1);
    assert.strictEqual(result.mappingCoverage, 1);
    assert.strictEqual(result.vectorCount, result.documentCount);
    assert.strictEqual(catalog.getActiveGeneration().vectorTable, 'vectors-g1');
    assert.ok(vectorIndex.writtenDocuments.some((document) => document.text.includes('summary')));
    assert.ok(vectorIndex.writtenDocuments.some((document) => document.text.includes('segment')));
    const searchResults = catalog.searchCharts({ query: 'Test Song' });
    assert.strictEqual(searchResults.length, 2);
    assert.strictEqual(searchResults[0].statsAvg, 98);
    assert.strictEqual(searchResults[1].statsAvg, 97);

    const noOpClient = { async fetchAll() { return { music: { unchanged: true, etag: 'm1' }, stats: { unchanged: true, etag: 's1' }, maidata: { noop: true, sourceRevision: 'tree-1', currentTree: { 'songs/1001/maidata.txt': 'blob-1' }, changed: [], removed: [] } }; } };
    const noOp = await createMaimaiSyncWorker({ catalog, sourceClient: noOpClient, vectorIndex, summaryGenerator }).runOnce();
    assert.strictEqual(noOp.status, 'no_op');
    assert.strictEqual(fetchCount, 1);

    const failing = await createMaimaiSyncWorker({
      catalog,
      sourceClient: { async fetchAll() { throw new Error('download failed'); } },
      vectorIndex,
      summaryGenerator
    }).runOnce();
    assert.strictEqual(failing.status, 'failed');
    assert.strictEqual(catalog.getActiveGeneration().id, 1);
    console.log('maimaiSyncWorker.test.js passed');
  } finally {
    catalog.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

const assert = require('assert');

const { createMaimaiRetrievalService } = require('../src/features/maimai/retrieval-service');

module.exports = (async () => {
  const active = { id: 7, sourceRevision: 'tree-7', finishedAt: '2026-08-04T04:30:00.000Z', vectorTable: 'vectors-g7' };
  const sqlRows = [
    { chartKey: 'df:1:SD:3', contentHash: 'hash-a', title: 'A', mappingConfidence: 0.96 },
    { chartKey: 'df:2:DX:3', contentHash: 'hash-b', title: 'B', mappingConfidence: 0.92 }
  ];
  let vectorCandidates = null;
  const service = createMaimaiRetrievalService({
    catalog: {
      getActiveGeneration: () => active,
      searchCharts: (args) => { assert.strictEqual(args.limit, 100); return sqlRows; },
      getChartAnalysis: () => ({ status: 'ok', chart: sqlRows[0], candidates: [sqlRows[0]], segments: [{ segmentIndex: 0, rawText: '1,E' }], generation: active })
    },
    vectorIndex: {
      searchText: async (query, args) => {
        vectorCandidates = args.candidateContentHashes;
        return {
          ok: true,
          rows: [
            { contentHash: 'outside-sql-candidates', _distance: 0 },
            { contentHash: 'hash-b', _distance: 0.1 }
          ]
        };
      }
    },
    embedTexts: async () => [[1, 0, 0]],
    playerStore: {
      getLatestSnapshot: () => ({ status: 'fresh', fetchedAt: '2026-08-04T04:00:00.000Z', records: [{ chartKey: 'df:1:SD:3' }], weaknesses: [] })
    }
  });
  const search = await service.searchCharts({ query: 'A', limit: 10 });
  assert.strictEqual(search.results[0].chartKey, 'df:2:DX:3');
  assert.strictEqual(search.results.some((row) => row.contentHash === 'outside-sql-candidates'), false);
  assert.deepStrictEqual(vectorCandidates.sort(), ['hash-a', 'hash-b']);
  assert.strictEqual(search.evidence.dataVersion, 'tree-7');
  assert.strictEqual(search.evidence.retrievalMode, 'hybrid');

  const detail = await service.analyzeChart({ query: 'A', title: 'A' });
  assert.strictEqual(detail.status, 'ok');
  assert.strictEqual(detail.answerPolicy, 'answer');
  assert.strictEqual(detail.segments.length, 1);

  const missingTitle = await service.analyzeChart({ query: '分析这张谱面' });
  assert.strictEqual(missingTitle.status, 'ambiguous');
  assert.strictEqual(missingTitle.reason, 'missing_title');
  assert.strictEqual(missingTitle.answerPolicy, 'clarify');

  const sqlOnly = createMaimaiRetrievalService({
    catalog: { getActiveGeneration: () => active, searchCharts: () => sqlRows },
    vectorIndex: { searchText: async () => ({ ok: false, mode: 'sql_only', reason: 'embedding_failed', rows: [] }) },
    playerStore: {}
  });
  const fallback = await sqlOnly.searchCharts({ query: 'A' });
  assert.strictEqual(fallback.evidence.retrievalMode, 'sql_only');
  assert.strictEqual(fallback.evidence.degraded, true);

  const noMatchService = createMaimaiRetrievalService({
    catalog: { getActiveGeneration: () => active, searchCharts: () => [] },
    playerStore: {}
  });
  const noMatch = await noMatchService.searchCharts({ query: 'missing' });
  assert.strictEqual(noMatch.status, 'not_found');
  assert.strictEqual(noMatch.answerPolicy, 'clarify');

  const uncertainService = createMaimaiRetrievalService({
    catalog: {
      getActiveGeneration: () => active,
      getChartAnalysis: ({ title }) => title === 'ambiguous'
        ? { status: 'ambiguous', reason: 'multiple_matches', chart: null, candidates: [...sqlRows, ...sqlRows, ...sqlRows], segments: [{ segmentIndex: 0 }] }
        : { status: 'not_found', reason: 'no_exact_match', chart: null, candidates: [], segments: [] }
    },
    playerStore: {}
  });
  const ambiguous = await uncertainService.analyzeChart({ query: 'x', title: 'ambiguous' });
  assert.strictEqual(ambiguous.status, 'ambiguous');
  assert.strictEqual(ambiguous.answerPolicy, 'clarify');
  assert.strictEqual(ambiguous.candidates.length, 5);
  assert.strictEqual(ambiguous.segments.length, 0);
  const notFound = await uncertainService.analyzeChart({ query: 'x', title: 'missing' });
  assert.strictEqual(notFound.status, 'not_found');
  assert.strictEqual(notFound.answerPolicy, 'clarify');
  assert.strictEqual(notFound.segments.length, 0);

  const player = await service.playerAnalysis({ query: '弱项', focus: '滑键', __context: { userId: '10001' } });
  assert.strictEqual(player.status, 'ok');
  assert.strictEqual(player.snapshotStatus, 'fresh');
  assert.strictEqual(player.evidence.retrievalMode, 'player_snapshot');
  assert.strictEqual(player.records.length, 1);
  assert.strictEqual(player.userId, undefined);
  await assert.rejects(() => service.playerAnalysis({ query: 'x', __context: {} }), /current QQ user/);
  console.log('maimaiRetrieval.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

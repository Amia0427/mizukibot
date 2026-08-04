const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildChartDocuments,
  createSummaryGenerator,
  validatePolishedSummary
} = require('../src/features/maimai/summary');
const {
  createModelSummaryPolisher
} = require('../src/features/maimai/summary-polisher');
const { createMaimaiVectorIndex } = require('../src/features/maimai/vector-index');

module.exports = (async () => {
  const facts = {
    chartKey: 'df:42:DX:3',
    title: 'Test Song',
    chartType: 'DX',
    difficultyIndex: 3,
    level: '12+',
    constant: 12.7,
    noteTotal: 100,
    featureAlgorithmVersion: 'maimai_features_v1',
    noteCounts: { tap: 70, touch: 5, hold: 10, slide: 12, break: 3 },
    density: 3.1,
    peakDensity: 6.2,
    chordCount: 8,
    interactionCount: 4,
    verticalStreamCount: 3,
    slideComboCount: 5,
    techniqueTags: ['纵连', '滑键组合'],
    segments: [{ segmentIndex: 5, startTime: 10, endTime: 18, intensity: 4.2, rawText: '(180){4}1,E' }]
  };
  const docs = buildChartDocuments(facts);
  assert.strictEqual(docs.length, 2);
  assert.ok(docs.every((doc) => doc.contentHash === facts.chartKey || doc.chartKey === facts.chartKey));
  assert.match(docs[0].text, /Test Song/);
  assert.match(docs[1].text, /10\.0-18\.0/);

  const invalid = validatePolishedSummary({ chartKey: 'other', segmentCount: 99, tags: ['不存在'] }, facts);
  assert.strictEqual(invalid.ok, false);
  const valid = validatePolishedSummary({
    chartKey: facts.chartKey,
    segmentCount: 1,
    segments: [{ segmentIndex: 5, text: 'valid' }],
    tags: ['纵连'],
    values: { density: 3.1 }
  }, facts);
  assert.strictEqual(valid.ok, true);

  const polishedGenerator = createSummaryGenerator({
    polish: async () => [{
      chartKey: facts.chartKey,
      segmentCount: 1,
      segments: [{ segmentIndex: 5, text: '润色后的代表段' }],
      tags: ['纵连'],
      values: { density: 3.1 }
    }]
  });
  const polished = await polishedGenerator.generate([facts]);
  assert.strictEqual(polished[0].segments[0].text, '润色后的代表段');
  assert.match(buildChartDocuments(facts, polished[0])[1].text, /润色后的代表段/);

  let modelRequest = null;
  const modelPolisher = createModelSummaryPolisher({
    apiBaseUrl: 'https://model.example/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    postWithRetry: async (url, body) => {
      modelRequest = { url, body };
      return {
        data: {
          choices: [{
            message: {
              content: JSON.stringify([{
                chartKey: facts.chartKey,
                segmentCount: 1,
                text: '模型摘要',
                segments: [{ segmentIndex: 5, text: '模型代表段' }],
                tags: ['纵连'],
                values: { density: 3.1 }
              }])
            }
          }]
        }
      };
    }
  });
  const modelResult = await modelPolisher([{ chart: facts, documents: docs }]);
  assert.strictEqual(modelResult[0].text, '模型摘要');
  assert.strictEqual(modelRequest.url, 'https://model.example/v1/chat/completions');
  assert.strictEqual(modelRequest.body.__trace.purpose, 'maimai_chart_summary_polish');

  let calls = 0;
  const generator = createSummaryGenerator({
    polish: async (batch) => { calls += 1; return batch.map(() => ({ chartKey: facts.chartKey, segmentCount: 1, tags: ['不存在'], values: { density: 999 } })); },
    cache: new Map()
  });
  const summaries = await generator.generate([facts]);
  assert.strictEqual(calls, 1);
  assert.ok(summaries[0].segments.every((segment) => segment.text.includes('纵连')));
  assert.strictEqual(summaries[0].mode, 'deterministic_fallback');
  const failedPolish = createSummaryGenerator({ polish: async () => { throw new Error('model unavailable'); } });
  const fallback = await failedPolish.generate([facts]);
  assert.strictEqual(fallback[0].mode, 'deterministic_fallback');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-maimai-vector-'));
  const vectors = createMaimaiVectorIndex({
    dir: path.join(tempRoot, 'lancedb'),
    embeddingModel: 'BAAI/bge-m3',
    embeddingDimension: 3,
    embedTexts: async (texts) => texts.map((text) => text.includes('slide') ? [0, 1, 0] : [1, 0, 0])
  });
  try {
    const empty = await vectors.writeDocuments([], { generationId: 3 });
    assert.deepStrictEqual(empty, {
      ok: true,
      tableName: 'maimai_chart_segments_baai_bge_m3_3_baai_bge_m3_g3',
      vectorCount: 0
    });
    const written = await vectors.writeDocuments([
      { id: 'doc-a', generationId: 1, chartKey: facts.chartKey, contentHash: 'hash-a', text: 'tap' },
      { id: 'doc-b', generationId: 1, chartKey: facts.chartKey, contentHash: 'hash-b', text: 'slide' }
    ]);
    assert.strictEqual(written.ok, true);
    assert.strictEqual(written.vectorCount, 2);
    const result = await vectors.searchText('slide', { candidateContentHashes: ['hash-a'] });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0].contentHash, 'hash-a');
    assert.match(vectors.tableName, /bge_m3_3/);
  } finally {
    await vectors.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log('maimaiSummaryVector.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

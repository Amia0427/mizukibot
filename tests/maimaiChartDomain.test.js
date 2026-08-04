const assert = require('assert');

const {
  analyzeSimaiChart,
  buildRawCells,
  normalizeSongTitle
} = require('../src/features/maimai/chart-analysis');
const { mapSourceCharts } = require('../src/features/maimai/chart-mapping');
const { inferPlayerWeaknesses } = require('../src/features/maimai/player-analysis');

module.exports = (() => {
  const rawChart = '(120){4}1,2,3,4,1/5,1h[4:1],1-5[4:1],A1,1b,(180){8}1,1,1,E';
  const analysis = analyzeSimaiChart(rawChart);

  assert.strictEqual(normalizeSongTitle('  Ｔｅｓｔ・Song！ '), 'testsong');
  assert.strictEqual(analysis.featureAlgorithmVersion, 'maimai_features_v1');
  assert.strictEqual(analysis.noteCounts.tap, 10);
  assert.strictEqual(analysis.noteCounts.touch, 1);
  assert.strictEqual(analysis.noteCounts.hold, 1);
  assert.strictEqual(analysis.noteCounts.slide, 1);
  assert.strictEqual(analysis.noteCounts.break, 1);
  assert.strictEqual(analysis.chordCount, 1);
  assert.ok(analysis.verticalStreamCount >= 1);
  assert.strictEqual(analysis.bpmChangeCount, 1);
  assert.ok(analysis.segments.length >= 1 && analysis.segments.length <= 3);
  assert.ok(analysis.segments.every((segment) => segment.rawText.length > 0));

  const cells = buildRawCells(rawChart, analysis.chart.timingChanges);
  assert.strictEqual(cells[0].time, 0);
  assert.ok(cells.some((cell) => cell.raw.includes('(180)')));

  const songs = [{
    id: '1001',
    title: 'Test Song',
    type: 'SD',
    ds: [4, 7, 10, 12],
    level: ['4', '7', '10', '12'],
    charts: [
      { notes: [1, 0, 0, 0], charter: '-' },
      { notes: [2, 0, 0, 0], charter: '-' },
      { notes: [3, 0, 0, 0], charter: '-' },
      { notes: [7, 1, 1, 1, 1], charter: 'Mapper' }
    ]
  }];
  const mappings = mapSourceCharts(songs, [{
    sourceChartKey: 'source:1001:3',
    sourceId: '1001',
    title: 'Ｔｅｓｔ Song[SD]',
    chartType: 'SD',
    difficultyIndex: 3,
    noteTotal: 11,
    charter: 'Mapper',
    contentHash: 'hash-1'
  }]);
  assert.strictEqual(mappings[0].status, 'confirmed');
  assert.strictEqual(mappings[0].chartKey, 'df:1001:SD:3');

  const ambiguous = mapSourceCharts([
    songs[0],
    { ...songs[0], id: '1002' }
  ], [{
    sourceChartKey: 'source:unknown:3',
    title: 'Test Song',
    chartType: 'SD',
    difficultyIndex: 3,
    noteTotal: 11,
    charter: 'Mapper',
    contentHash: 'hash-2'
  }]);
  assert.strictEqual(ambiguous[0].status, 'quarantined');

  const records = Array.from({ length: 30 }, (_, index) => ({
    chartKey: `df:${index}:DX:3`,
    performanceZ: 1 - (index / 10),
    features: {
      slideIntensity: index + 1,
      touchIntensity: index % 2
    }
  }));
  const weaknesses = inferPlayerWeaknesses(records);
  assert.strictEqual(weaknesses.status, 'ok');
  assert.strictEqual(weaknesses.items[0].feature, 'slideIntensity');
  assert.ok(weaknesses.items[0].correlation <= -0.9);
  assert.match(weaknesses.notice, /成绩相关性.*推断/);

  const insufficient = inferPlayerWeaknesses(records.slice(0, 10));
  assert.strictEqual(insufficient.status, 'insufficient_data');

  console.log('maimaiChartDomain.test.js passed');
})();

const assert = require('assert');
const {
  analyzeSusChart,
  assignTechniqueTags,
  buildChartKey,
  normalizeDifficulty
} = require('../src/features/pjsk/chart-analysis');

const SIMPLE_SUS = [
  '#REQUEST "ticks_per_beat 480"',
  '#00002: 4',
  '#BPM01: 120',
  '#00008: 01',
  '#00012:0011',
  '#00114:0011'
].join('\n');

module.exports = (async () => {
  const first = await analyzeSusChart(SIMPLE_SUS);
  const second = await analyzeSusChart(SIMPLE_SUS);
  assert.strictEqual(first.noteTotal, 2);
  assert.deepStrictEqual(first.segments, second.segments);
  assert.strictEqual(first.featureAlgorithmVersion, 'pjsk-usc-v1');
  assert.strictEqual(first.bpmMin, 120);
  assert.strictEqual(first.bpmMax, 120);
  assert.strictEqual(buildChartKey(1, 'master'), 'jp:1:master');
  assert.strictEqual(normalizeDifficulty('紫谱'), 'master');
  assert.strictEqual(normalizeDifficulty('红谱'), 'expert');

  const tagged = assignTechniqueTags([
    { level: 30, density: 2, peakDensity: 3, noteCounts: { flick: 1, slide: 1, trace: 0 }, chordCount: 1, wideNoteCount: 0, bpmChangeCount: 0, timeScaleChangeCount: 0 },
    { level: 30, density: 5, peakDensity: 8, noteCounts: { flick: 8, slide: 7, trace: 5 }, chordCount: 8, wideNoteCount: 6, bpmChangeCount: 1, timeScaleChangeCount: 0 }
  ]);
  assert.ok(tagged[1].techniqueTags.includes('高密度'));
  assert.ok(tagged[1].techniqueTags.includes('含变速'));
  console.log('pjskChartAnalysis.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

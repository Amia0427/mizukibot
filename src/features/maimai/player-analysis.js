const FEATURE_LABELS = Object.freeze({
  density: '整体密度',
  peakDensity: '密度峰值',
  chordIntensity: '双押',
  interactionIntensity: '交互',
  verticalStreamIntensity: '纵连',
  slideIntensity: '滑键组合',
  touchIntensity: 'Touch',
  breakIntensity: 'Break',
  bpmChangeIntensity: 'BPM变化'
});

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ranks(values = []) {
  const sorted = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  const output = Array(values.length).fill(0);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end += 1;
    const rank = (start + end - 1) / 2 + 1;
    for (let index = start; index < end; index += 1) output[sorted[index].index] = rank;
    start = end;
  }
  return output;
}

function pearson(left = [], right = []) {
  if (left.length !== right.length || left.length < 2) return 0;
  const leftMean = average(left);
  const rightMean = average(right);
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    numerator += a * b;
    leftSquare += a * a;
    rightSquare += b * b;
  }
  if (leftSquare <= 0 || rightSquare <= 0) return 0;
  return numerator / Math.sqrt(leftSquare * rightSquare);
}

function spearman(left = [], right = []) {
  return pearson(ranks(left), ranks(right));
}

function confidenceForSupport(sampleCount = 0, correlation = 0) {
  const support = Math.min(1, Math.sqrt(sampleCount / 50));
  const effect = Math.min(1, Math.abs(correlation));
  const score = support * effect;
  if (sampleCount >= 80 && score >= 0.5) return 'high';
  if (sampleCount >= 40 && score >= 0.3) return 'medium';
  return 'low';
}

function inferPlayerWeaknesses(records = [], options = {}) {
  const rows = (Array.isArray(records) ? records : []).filter((record) => (
    Number.isFinite(Number(record.performanceZ))
    && record.features
    && typeof record.features === 'object'
  ));
  const minimumRecords = Math.max(1, Number(options.minimumRecords || 20) || 20);
  if (rows.length < minimumRecords) {
    return {
      status: 'insufficient_data',
      sampleCount: rows.length,
      items: [],
      notice: '成绩样本不足，暂不推断具体手法弱项。'
    };
  }

  const featureNames = new Set(rows.flatMap((record) => Object.keys(record.features || {})));
  const items = [];
  for (const feature of featureNames) {
    const samples = rows
      .map((record) => ({ x: Number(record.features[feature]), y: Number(record.performanceZ) }))
      .filter((sample) => Number.isFinite(sample.x) && Number.isFinite(sample.y));
    const nonZeroCount = samples.filter((sample) => sample.x !== 0).length;
    if (samples.length < minimumRecords || nonZeroCount < 8 || new Set(samples.map((sample) => sample.x)).size < 3) continue;
    const correlation = spearman(samples.map((sample) => sample.x), samples.map((sample) => sample.y));
    if (correlation > -0.2) continue;
    items.push({
      feature,
      label: FEATURE_LABELS[feature] || feature,
      correlation,
      sampleCount: samples.length,
      confidence: confidenceForSupport(samples.length, correlation),
      score: -correlation * Math.min(1, Math.sqrt(samples.length / 50))
    });
  }
  items.sort((left, right) => right.score - left.score || left.feature.localeCompare(right.feature));
  return {
    status: 'ok',
    sampleCount: rows.length,
    items: items.slice(0, Math.max(1, Math.min(3, Number(options.limit || 3) || 3))),
    notice: '以下仅为基于成绩相关性的推断，不能定位你在实际游玩中的具体掉音位置。'
  };
}

module.exports = {
  FEATURE_LABELS,
  inferPlayerWeaknesses,
  spearman
};

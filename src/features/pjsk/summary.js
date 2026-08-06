const crypto = require('crypto');

function hashText(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function buildChartDocuments(chart = {}) {
  const counts = chart.noteCounts || {};
  const facts = [
    `曲名 ${chart.title}`,
    `作者 ${[chart.lyricist, chart.composer, chart.arranger].filter(Boolean).join(' / ')}`,
    `难度 ${chart.difficulty.toUpperCase()}`,
    `官方等级 ${chart.level}`,
    `官方物量 ${chart.noteTotal}`
  ].filter(Boolean).join('；');
  const featureSummary = [
    `${facts}。`,
    `时长 ${chart.duration.toFixed(1)} 秒，BPM ${chart.bpmMin}-${chart.bpmMax}，变速 ${chart.bpmChangeCount + chart.timeScaleChangeCount} 次。`,
    `Tap ${counts.tap}，Flick ${counts.flick}，Slide ${counts.slide}，Trace ${counts.trace}，Critical ${counts.critical}，多押 ${chart.chordCount}，宽键 ${chart.wideNoteCount}。`,
    `平均密度 ${chart.density.toFixed(2)}，峰值密度 ${chart.peakDensity.toFixed(2)}。`,
    `技术标签 ${(chart.techniqueTags || []).join('、') || '无显著分位标签'}。`
  ].join('');
  const documents = [
    { id: `${chart.chartKey}:song`, kind: 'song', segmentIndex: -1, text: facts },
    { id: `${chart.chartKey}:features`, kind: 'features', segmentIndex: -1, text: featureSummary }
  ];
  for (const segment of chart.segments || []) {
    documents.push({
      id: `${chart.chartKey}:segment:${segment.segmentIndex}`,
      kind: 'segment',
      segmentIndex: segment.segmentIndex,
      text: `${facts}；代表段 ${segment.rawText}`
    });
  }
  return documents.map((document) => ({
    ...document,
    chartKey: chart.chartKey,
    contentHash: chart.contentHash,
    documentHash: hashText(document.text),
    generationId: Number(chart.generationId || 0)
  }));
}

module.exports = { buildChartDocuments, hashText };

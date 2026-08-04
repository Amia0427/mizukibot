const { analyzeSimaiChart } = require('./chart-analysis');
const { buildMaidataCharts } = require('./source-client');
const { flattenDivingFishCharts, mapSourceCharts } = require('./chart-mapping');
const { buildChartDocuments, createSummaryGenerator } = require('./summary');

function sumNoteCounts(noteCounts = {}) {
  return ['tap', 'touch', 'hold', 'slide', 'break'].reduce(
    (sum, key) => sum + (Number(noteCounts[key]) || 0),
    0
  );
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value || ''));
  } catch (_) {
    return fallback;
  }
}

function buildStatsLookup(stats = {}) {
  const lookup = new Map();
  const charts =
    stats.charts && typeof stats.charts === 'object' ? stats.charts : stats;
  for (const [musicId, rows] of Object.entries(charts)) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const indexKeys = [
        row.level_index,
        row.levelIndex,
        row.difficulty_index
      ].filter(
        (value) =>
          value !== undefined && value !== null && String(value).trim() !== ''
      );
      const valueKeys = [row.diff, row.level, row.ds, row.constant].filter(
        (value) =>
          value !== undefined && value !== null && String(value).trim() !== ''
      );
      for (const key of indexKeys)
        lookup.set(`${musicId}:index:${String(key)}`, row);
      for (const key of valueKeys)
        lookup.set(`${musicId}:value:${String(key)}`, row);
    }
  }
  return lookup;
}

function createMaimaiSyncWorker(options = {}) {
  const catalog = options.catalog;
  const sourceClient = options.sourceClient;
  const vectorIndex = options.vectorIndex;
  const summaryGenerator = options.summaryGenerator || createSummaryGenerator();
  if (!catalog || !sourceClient || !vectorIndex)
    throw new Error('maimai sync worker dependencies are required');

  async function runOnce() {
    catalog.markStaleRunsFailed();
    const previousTree = parseJson(
      catalog.getMetaValue('maidata_tree_json', '{}'),
      {}
    );
    const previousFiles = parseJson(
      catalog.getMetaValue('maidata_files_json', '{}'),
      {}
    );
    const musicEtag = catalog.getMetaValue('music_etag', '');
    const statsEtag = catalog.getMetaValue('stats_etag', '');
    const sourceRevision = catalog.getMetaValue('source_revision', '');
    let fetched;
    try {
      fetched = await sourceClient.fetchAll({
        previousTree,
        musicEtag,
        statsEtag,
        sourceRevision
      });
    } catch (error) {
      return { status: 'failed', error: String(error.message || error) };
    }
    const sourceNoop =
      fetched.maidata?.noop === true &&
      fetched.music?.unchanged === true &&
      fetched.stats?.unchanged === true;
    if (sourceNoop) {
      const runId = catalog.recordNoopSync({
        musicEtag: fetched.music.etag || musicEtag,
        statsEtag: fetched.stats.etag || statsEtag,
        sourceRevision: fetched.maidata.sourceRevision || sourceRevision
      });
      return { status: 'no_op', runId };
    }

    const runId = catalog.startSync({
      musicEtag: fetched.music.etag,
      statsEtag: fetched.stats.etag,
      sourceRevision: fetched.maidata.sourceRevision
    });
    let parsedRatio = 0;
    let mappingCoverage = 0;
    try {
      const files = { ...previousFiles };
      for (const entry of fetched.maidata?.changed || [])
        files[entry.path] = entry;
      for (const filePath of fetched.maidata?.removed || [])
        delete files[filePath];
      const maidataEntries = Object.values(files);
      const music = fetched.music?.unchanged
        ? parseJson(catalog.getMetaValue('music_json', '[]'), [])
        : fetched.music?.songs || [];
      const stats = fetched.stats?.unchanged
        ? parseJson(catalog.getMetaValue('stats_json', '{}'), {})
        : fetched.stats?.charts || {};
      const sourceBundle = buildMaidataCharts(maidataEntries);
      const targetCharts = flattenDivingFishCharts(music);
      const statsLookup = buildStatsLookup(stats);
      const charts = targetCharts.map((chart) => {
        const row =
          statsLookup.get(`${chart.musicId}:index:${chart.difficultyIndex}`) ||
          statsLookup.get(`${chart.musicId}:value:${chart.level}`) ||
          statsLookup.get(`${chart.musicId}:value:${String(chart.constant)}`) ||
          {};
        return {
          ...chart,
          statsAvg: Number(row.avg || 0),
          statsStdDev: Number(row.std_dev || 0),
          artist: ''
        };
      });
      const analyses = [];
      const parsedSourceCharts = [];
      for (const source of sourceBundle.sourceCharts) {
        try {
          const analysis = analyzeSimaiChart(source.rawChart);
          analyses.push({
            ...analysis,
            contentHash: source.contentHash,
            sourceChartKey: source.sourceChartKey,
            rawChart: source.rawChart
          });
          parsedSourceCharts.push({
            ...source,
            noteTotal: sumNoteCounts(analysis.noteCounts)
          });
        } catch (_) {
          // Failed charts remain outside the confirmed mapping set and count against parse quality.
        }
      }
      const mappings = mapSourceCharts(music, parsedSourceCharts);
      parsedRatio =
        sourceBundle.sourceCharts.length > 0
          ? parsedSourceCharts.length / sourceBundle.sourceCharts.length
          : 0;
      mappingCoverage =
        mappings.length > 0
          ? mappings.filter((mapping) => mapping.status === 'confirmed')
              .length / mappings.length
          : 0;
      if (parsedRatio < 0.99)
        throw new Error('maimai parsed ratio is below 0.99');
      if (mappingCoverage < 0.75)
        throw new Error('maimai mapping coverage is below 0.75');
      const activeGeneration = catalog.getActiveGeneration();
      if (
        activeGeneration &&
        mappingCoverage < Number(activeGeneration.mappingCoverage || 0) - 0.02
      ) {
        throw new Error('maimai mapping coverage dropped by more than 0.02');
      }
      const chartFacts = [];
      for (const chart of charts) {
        const mapping = mappings.find(
          (candidate) =>
            candidate.chartKey === chart.chartKey &&
            candidate.status === 'confirmed'
        );
        if (!mapping) continue;
        const analysis = analyses.find(
          (candidate) => candidate.contentHash === mapping.contentHash
        );
        if (!analysis) continue;
        chartFacts.push({
          ...chart,
          ...analysis,
          contentHash: mapping.contentHash,
          generationId: 0
        });
      }
      const summaries = await summaryGenerator.generate(chartFacts);
      const summaryByChart = new Map(
        summaries.map((summary) => [summary.chartKey, summary])
      );
      const features = analyses.map((analysis) => {
        const { chart: _chart, ...serializable } = analysis;
        return { ...serializable, contentHash: analysis.contentHash };
      });
      const events = analyses.flatMap((analysis) =>
        (analysis.events || []).map((event, eventIndex) => ({
          ...event,
          contentHash: analysis.contentHash,
          eventIndex
        }))
      );
      const sources = sourceBundle.sourceCharts.map((source) => ({
        contentHash: source.contentHash,
        rawChart: source.rawChart,
        parseStatus: analyses.some(
          (item) => item.contentHash === source.contentHash
        )
          ? 'ok'
          : 'failed'
      }));
      const segments = chartFacts.flatMap((chart) => {
        const summary = summaryByChart.get(chart.chartKey);
        return (chart.segments || []).slice(0, 3).map((segment) => {
          const summarySegment = summary?.segments?.find(
            (item) => item.segmentIndex === segment.segmentIndex
          );
          return {
            contentHash: chart.contentHash,
            segmentIndex: segment.segmentIndex,
            startTime: segment.startTime,
            endTime: segment.endTime,
            intensity: segment.intensity,
            rawText: segment.rawText,
            templateText: summarySegment?.templateText || segment.rawText,
            polishedText: summarySegment?.text || segment.rawText,
            documentHash: `${chart.contentHash}:${segment.segmentIndex}`
          };
        });
      });
      const documents = chartFacts.flatMap((chart) =>
        buildChartDocuments(chart, summaryByChart.get(chart.chartKey))
      );
      const vectorResult = await vectorIndex.writeDocuments(documents, {
        generationId: runId
      });
      if (!vectorResult.ok)
        throw new Error(vectorResult.reason || 'vector write failed');
      const songs = Array.from(
        new Map(
          charts.map((chart) => [
            `${chart.musicId}:${chart.chartType}`,
            { ...chart, artist: '' }
          ])
        ).values()
      );
      catalog.replaceGeneration(runId, {
        songs,
        charts,
        sources,
        mappings,
        features,
        events,
        segments
      });
      catalog.activateGeneration(runId, {
        vectorTable: vectorResult.tableName,
        parsedRatio,
        mappingCoverage,
        documentCount: documents.length,
        vectorCount: vectorResult.vectorCount
      });
      catalog.setMetaValue('music_etag', fetched.music.etag || '');
      catalog.setMetaValue('stats_etag', fetched.stats.etag || '');
      catalog.setMetaValue(
        'source_revision',
        fetched.maidata.sourceRevision || ''
      );
      catalog.setMetaValue(
        'maidata_tree_json',
        JSON.stringify(fetched.maidata.currentTree || {})
      );
      catalog.setMetaValue('maidata_files_json', JSON.stringify(files));
      catalog.setMetaValue('music_json', JSON.stringify(music));
      catalog.setMetaValue('stats_json', JSON.stringify(stats));
      return {
        status: 'active',
        runId,
        parsedRatio,
        mappingCoverage,
        documentCount: documents.length,
        vectorCount: vectorResult.vectorCount,
        quarantinedCount: mappings.filter(
          (mapping) => mapping.status !== 'confirmed'
        ).length
      };
    } catch (error) {
      catalog.failSync(runId, error.message || String(error));
      return {
        status: 'failed',
        runId,
        error: error.message || String(error),
        parsedRatio,
        mappingCoverage
      };
    }
  }

  return { runOnce };
}

module.exports = {
  createMaimaiSyncWorker,
  buildStatsLookup,
  sumNoteCounts
};

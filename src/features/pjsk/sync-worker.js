const { analyzeSusChart, assignTechniqueTags } = require('./chart-analysis');
const { MASTER_FILES, buildMasterCatalog, sha256 } = require('./source-client');
const { buildChartDocuments, hashText } = require('./summary');

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value || ''));
  } catch (_) {
    return fallback;
  }
}

function createPjskSyncWorker(options = {}) {
  const catalog = options.catalog;
  const sourceClient = options.sourceClient;
  const vectorIndex = options.vectorIndex;
  const analyzeChart = options.analyzeChart || analyzeSusChart;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  if (!catalog || !sourceClient || !vectorIndex) throw new Error('PJSK sync worker dependencies are required');

  async function resolveMaster() {
    const previousEtags = parseJson(catalog.getMetaValue('master_etags_json', '{}'), {});
    const fetched = await sourceClient.fetchMaster({ etags: previousEtags });
    const master = {};
    const hashes = parseJson(catalog.getMetaValue('master_hashes_json', '{}'), {});
    const manifest = {};
    for (const [name] of MASTER_FILES) {
      const file = fetched.files[name];
      const cached = catalog.getMetaValue(`master_${name}_json`, '');
      const text = file.unchanged ? cached : file.text;
      if (!text) throw new Error(`PJSK cached master ${name} is unavailable`);
      master[name] = JSON.parse(text);
      hashes[name] = file.hash || hashes[name] || sha256(text);
      manifest[name] = { url: file.url, etag: file.etag || '', hash: hashes[name] };
    }
    return {
      catalog: buildMasterCatalog(master),
      etags: fetched.etags,
      hashes,
      manifest,
      raw: Object.fromEntries(MASTER_FILES.map(([name]) => [name, fetched.files[name].unchanged ? null : fetched.files[name].text])),
      sourceRevision: sha256(MASTER_FILES.map(([name]) => `${name}:${hashes[name]}`).join('|')),
      unchanged: fetched.unchanged
    };
  }

  async function runOnce() {
    catalog.markStaleRunsFailed();
    let master;
    try {
      master = await resolveMaster();
    } catch (error) {
      return { status: 'failed', error: String(error.message || error) };
    }
    if (master.unchanged && catalog.getActiveGeneration() && !catalog.hasPendingPublishedCharts(now())) {
      const runId = catalog.recordNoopSync({ sourceRevision: master.sourceRevision, sourceManifest: master.manifest });
      return { status: 'no_op', runId };
    }

    const runId = catalog.startSync({ sourceRevision: master.sourceRevision, sourceManifest: master.manifest });
    try {
      const songById = new Map(master.catalog.songs.map((song) => [song.musicId, song]));
      const publishedCharts = master.catalog.charts.filter((chart) => songById.get(chart.musicId)?.publishedAt <= now().getTime());
      if (publishedCharts.length === 0) throw new Error('PJSK published chart catalog is empty');
      const cachedSources = catalog.getCachedSources(publishedCharts.map((chart) => chart.chartKey));
      const fetchedSources = await sourceClient.fetchSusBatch(publishedCharts, cachedSources);
      const fetchedByKey = new Map(fetchedSources.map((source) => [source.chartKey, source]));
      const analyses = [];
      const sources = [];
      const chartStates = new Map();
      let parseSuccessCount = 0;
      let verifiedCount = 0;

      for (const chart of publishedCharts) {
        const source = fetchedByKey.get(chart.chartKey);
        if (!source || source.error || !source.rawSus) {
          chartStates.set(chart.chartKey, { parseStatus: 'failed', parseError: source?.error || 'SUS unavailable' });
          continue;
        }
        try {
          const analysis = await analyzeChart(source.rawSus);
          parseSuccessCount += 1;
          const matchesOfficial = Number(analysis.noteTotal) === Number(chart.noteTotal);
          if (matchesOfficial) verifiedCount += 1;
          const parseStatus = matchesOfficial ? 'ok' : 'note_mismatch';
          const parseError = matchesOfficial ? '' : `official=${chart.noteTotal},parsed=${analysis.noteTotal}`;
          sources.push({ ...source, parseStatus, parseError, fetchedAt: now().toISOString() });
          chartStates.set(chart.chartKey, {
            contentHash: source.contentHash,
            parseStatus,
            parseError,
            featureAlgorithmVersion: analysis.featureAlgorithmVersion
          });
          if (matchesOfficial) analyses.push({
            ...analysis,
            chartKey: chart.chartKey,
            musicId: chart.musicId,
            difficulty: chart.difficulty,
            level: chart.level,
            officialNoteTotal: chart.noteTotal,
            contentHash: source.contentHash
          });
        } catch (error) {
          const parseError = String(error.message || error).slice(0, 300);
          sources.push({ ...source, parseStatus: 'failed', parseError, fetchedAt: now().toISOString() });
          chartStates.set(chart.chartKey, { contentHash: source.contentHash, parseStatus: 'failed', parseError });
        }
      }

      const parsedRatio = parseSuccessCount / publishedCharts.length;
      const noteVerificationCoverage = verifiedCount / publishedCharts.length;
      if (parsedRatio < 0.99) throw new Error('PJSK parsed ratio is below 0.99');
      if (noteVerificationCoverage < 0.99) throw new Error('PJSK note verification coverage is below 0.99');

      assignTechniqueTags(analyses);
      const analysisByKey = new Map(analyses.map((analysis) => [analysis.chartKey, analysis]));
      const charts = master.catalog.charts.map((chart) => {
        const song = songById.get(chart.musicId);
        if (song.publishedAt > now().getTime()) return { ...chart, parseStatus: 'unpublished', parseError: '' };
        return { ...chart, ...(chartStates.get(chart.chartKey) || { parseStatus: 'failed', parseError: 'SUS unavailable' }) };
      });
      const features = analyses.map((analysis) => ({ ...analysis, noteTotal: analysis.officialNoteTotal }));
      const segments = analyses.flatMap((analysis) => analysis.segments.map((segment) => ({
        contentHash: analysis.contentHash,
        segmentIndex: segment.segmentIndex,
        startTime: segment.startTime,
        endTime: segment.endTime,
        intensity: segment.intensity,
        summaryText: segment.rawText,
        documentHash: hashText(`${analysis.contentHash}:${segment.rawText}`)
      })));
      const chartFacts = charts.flatMap((chart) => {
        const analysis = analysisByKey.get(chart.chartKey);
        const song = songById.get(chart.musicId);
        return analysis && song ? [{ ...song, ...chart, ...analysis, noteTotal: chart.noteTotal, generationId: runId }] : [];
      });
      const documents = chartFacts.flatMap(buildChartDocuments);

      catalog.replaceGeneration(runId, {
        ...master.catalog,
        charts,
        features,
        segments,
        sources
      });
      catalog.activateSqlGeneration(runId, { parsedRatio, noteVerificationCoverage });
      catalog.setMetaValue('master_etags_json', JSON.stringify(master.etags));
      catalog.setMetaValue('master_hashes_json', JSON.stringify(master.hashes));
      catalog.setMetaValue('source_revision', master.sourceRevision);
      for (const [name, text] of Object.entries(master.raw)) {
        if (text !== null) catalog.setMetaValue(`master_${name}_json`, text);
      }

      try {
        const vectorResult = await vectorIndex.writeDocuments(documents, { generationId: runId });
        if (!vectorResult.ok) throw new Error(vectorResult.reason || 'vector write failed');
        catalog.markVectorReady(runId, {
          vectorTable: vectorResult.tableName,
          documentCount: documents.length,
          vectorCount: vectorResult.vectorCount
        });
      } catch (error) {
        const reason = String(error.message || error);
        catalog.markVectorFailed(runId, reason);
        return {
          status: 'active_sql_only', runId, parsedRatio, noteVerificationCoverage,
          degradationReason: reason, chartCount: charts.length
        };
      }
      return {
        status: 'active', runId, parsedRatio, noteVerificationCoverage,
        chartCount: charts.length, documentCount: documents.length
      };
    } catch (error) {
      catalog.failSync(runId, error.message || error);
      return { status: 'failed', runId, error: String(error.message || error) };
    }
  }

  return { runOnce };
}

module.exports = { createPjskSyncWorker };

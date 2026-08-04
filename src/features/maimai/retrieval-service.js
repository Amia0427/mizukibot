function createEvidence(active, rows, retrievalMode, degraded = false) {
  const confidences = rows.map((row) => Number(row.mappingConfidence || 0)).filter((value) => value > 0);
  return {
    dataVersion: String(active?.sourceRevision || active?.id || ''),
    syncTime: String(active?.finishedAt || ''),
    mappingConfidence: confidences.length > 0 ? Math.min(...confidences) : 0,
    retrievalMode,
    degraded,
    vectorTable: String(active?.vectorTable || '')
  };
}

function createMaimaiRetrievalService(options = {}) {
  const catalog = options.catalog;
  const vectorIndex = options.vectorIndex;
  const playerStore = options.playerStore;
  const embedTexts = options.embedTexts;
  if (!catalog) throw new Error('maimai catalog is required');

  async function searchCharts(input = {}) {
    const active = catalog.getActiveGeneration();
    if (!active) return { status: 'unavailable', results: [], evidence: createEvidence(null, [], 'sql_only', true) };
    const candidates = catalog.searchCharts({ ...input, limit: 100 });
    if (candidates.length === 0) return { status: 'ok', results: [], evidence: createEvidence(active, [], 'sql_only') };
    const hashes = Array.from(new Set(candidates.map((row) => row.contentHash).filter(Boolean)));
    let vectorResult = { ok: false, mode: 'sql_only', rows: [] };
    if (vectorIndex && typeof vectorIndex.searchText === 'function') {
      vectorResult = await vectorIndex.searchText(input.query, {
        candidateContentHashes: hashes,
        tableName: active.vectorTable,
        limit: Math.min(20, Number(input.limit || 10) || 10)
      });
    } else if (typeof embedTexts === 'function') {
      try {
        const vectors = await embedTexts([input.query]);
        if (Array.isArray(vectors[0]) && vectorIndex?.search) {
          vectorResult = await vectorIndex.search(vectors[0], { candidateContentHashes: hashes, tableName: active.vectorTable });
        }
      } catch (_) {
        vectorResult = { ok: false, mode: 'sql_only', rows: [] };
      }
    }
    const vectorScores = new Map((vectorResult.rows || []).map((row) => [String(row.contentHash), Math.max(0, 1 - Number(row._distance || row.distance || 0))]));
    const ranked = candidates.map((row, index) => ({
      ...row,
      semanticScore: vectorScores.get(String(row.contentHash)) || 0,
      retrievalScore: (vectorScores.get(String(row.contentHash)) || 0) * 0.65 + (candidates.length - index) / candidates.length * 0.35
    })).sort((left, right) => right.retrievalScore - left.retrievalScore || left.chartKey.localeCompare(right.chartKey));
    const retrievalMode = vectorResult.ok === true && (vectorResult.rows || []).length > 0 ? 'hybrid' : 'sql_only';
    return {
      status: 'ok',
      results: ranked.slice(0, Math.max(1, Math.min(10, Number(input.limit || 10) || 10))),
      evidence: createEvidence(active, ranked, retrievalMode, retrievalMode === 'sql_only')
    };
  }

  async function analyzeChart(input = {}) {
    const active = catalog.getActiveGeneration();
    const detail = catalog.getChartAnalysis(input);
    const rows = detail.chart ? [detail.chart] : detail.candidates || [];
    return {
      ...detail,
      segments: (detail.segments || []).slice(0, 3),
      evidence: createEvidence(active, rows, 'sql_only', !active || detail.status !== 'ok')
    };
  }

  async function playerAnalysis(input = {}) {
    const userId = String(input.__context?.userId || '').trim();
    if (!userId) throw new Error('maimai player analysis requires the current QQ user');
    const snapshot = playerStore?.getLatestSnapshot?.(userId, input.__context?.snapshotOptions || {}) || { status: 'missing', records: [], weaknesses: [] };
    const active = catalog.getActiveGeneration();
    const records = snapshot.records || [];
    return {
      status: snapshot.status === 'missing' ? 'unavailable' : 'ok',
      snapshotStatus: snapshot.status,
      fetchedAt: snapshot.fetchedAt || '',
      records: records.slice(0, Math.max(1, Math.min(50, Number(input.limit || 10) || 10))),
      weaknesses: (snapshot.weaknesses || []).slice(0, 3),
      notice: snapshot.status === 'missing'
        ? '没有当前 QQ 用户的成绩快照，请先绑定或刷新。'
        : `${snapshot.status === 'stale' ? `当前使用 ${snapshot.fetchedAt || '未知时间'} 的旧成绩快照。` : ''}以下仅为基于成绩相关性的推断，不能定位你在实际游玩中的具体掉音位置。`,
      evidence: createEvidence(active, records, 'player_snapshot', snapshot.status !== 'fresh')
    };
  }

  return { analyzeChart, playerAnalysis, searchCharts };
}

module.exports = { createEvidence, createMaimaiRetrievalService };

function createEvidence(active, retrievalMode, degraded = false) {
  return {
    dataVersion: String(active?.sourceRevision || active?.id || ''),
    generationId: Number(active?.id || 0),
    syncTime: String(active?.finishedAt || ''),
    retrievalMode,
    degraded,
    vectorTable: retrievalMode === 'hybrid' ? String(active?.vectorTable || '') : ''
  };
}

function createPjskRetrievalService(options = {}) {
  const catalog = options.catalog;
  const vectorIndex = options.vectorIndex;
  if (!catalog) throw new Error('PJSK catalog is required');

  async function searchSongs(input = {}) {
    const active = catalog.getActiveGeneration();
    if (!active) return { status: 'unavailable', answerPolicy: 'retry', results: [], evidence: createEvidence(null, 'sql_only', true) };
    const candidates = catalog.searchCharts({ ...input, limit: 100 });
    if (candidates.length === 0) {
      return {
        status: 'not_found',
        answerPolicy: 'clarify',
        results: [],
        notice: '没有找到满足条件的已发布 PJSK 曲目或谱面。',
        evidence: createEvidence(active, 'sql_only')
      };
    }
    const hashes = Array.from(new Set(candidates.map((row) => row.contentHash).filter(Boolean)));
    let vectorResult = { ok: false, mode: 'sql_only', reason: 'vector_generation_not_ready', rows: [] };
    if (
      active.status === 'active'
      && Number(active.vectorGenerationId) === Number(active.id)
      && active.vectorTable
      && vectorIndex?.searchText
    ) {
      vectorResult = await vectorIndex.searchText(input.query, {
        generationId: active.id,
        tableName: active.vectorTable,
        candidateContentHashes: hashes,
        limit: Math.min(50, Math.max(10, Number(input.limit || 10) * 4))
      });
    }
    const allowedHashes = new Set(hashes);
    const vectorRows = (vectorResult.rows || []).filter((row) => allowedHashes.has(String(row.contentHash)));
    const scores = new Map();
    for (const row of vectorRows) {
      const score = Math.max(0, 1 - Number(row._distance ?? row.distance ?? 1));
      scores.set(String(row.contentHash), Math.max(score, scores.get(String(row.contentHash)) || 0));
    }
    const ranked = candidates.map((row, index) => ({
      ...row,
      semanticScore: scores.get(String(row.contentHash)) || 0,
      retrievalScore: (scores.get(String(row.contentHash)) || 0) * 0.65 + (candidates.length - index) / candidates.length * 0.35
    })).sort((left, right) => right.retrievalScore - left.retrievalScore || left.chartKey.localeCompare(right.chartKey));
    const retrievalMode = vectorResult.ok && vectorRows.length > 0 ? 'hybrid' : 'sql_only';
    return {
      status: 'ok',
      answerPolicy: 'answer',
      results: ranked.slice(0, Math.max(1, Math.min(10, Number(input.limit || 10) || 10))),
      evidence: createEvidence(active, retrievalMode, retrievalMode === 'sql_only'),
      ...(retrievalMode === 'sql_only' ? { degradationReason: vectorResult.reason || 'vector_empty' } : {})
    };
  }

  async function analyzeChart(input = {}) {
    const active = catalog.getActiveGeneration();
    if (!active) return { status: 'unavailable', answerPolicy: 'retry', chart: null, candidates: [], segments: [], evidence: createEvidence(null, 'sql_only', true) };
    const detail = catalog.getChartAnalysis(input);
    const answerPolicy = detail.status === 'ok' ? 'answer' : detail.status === 'unavailable' && !detail.chart ? 'retry' : 'clarify';
    const notices = {
      ambiguous: '存在多个候选，请补充曲名或 EASY、NORMAL、HARD、EXPERT、MASTER、APPEND 难度。',
      not_found: '没有找到完全匹配的已发布 PJSK 谱面。',
      unavailable: detail.chart ? '曲目元数据可用，但该谱面解析失败或物量校验未通过，暂不提供结构分析。' : 'PJSK 数据暂不可用。'
    };
    return {
      ...detail,
      answerPolicy,
      candidates: (detail.candidates || []).slice(0, 5),
      segments: detail.status === 'ok' ? (detail.segments || []).slice(0, 3) : [],
      ...(notices[detail.status] ? { notice: notices[detail.status] } : {}),
      evidence: createEvidence(active, 'sql_only', detail.status !== 'ok')
    };
  }

  return { analyzeChart, searchSongs };
}

module.exports = { createEvidence, createPjskRetrievalService };

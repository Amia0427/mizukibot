const { normalizeSongTitle } = require('./chart-analysis');

const DIFFICULTY_NAMES = Object.freeze(['Basic', 'Advanced', 'Expert', 'Master', 'Re:Master']);

function normalizeChartType(value = '') {
  return String(value || '').trim().toUpperCase() === 'DX' ? 'DX' : 'SD';
}

function normalizeCharter(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '').trim();
}

function normalizeSourceTitle(value = '') {
  return normalizeSongTitle(String(value || '').replace(/\[(?:DX|SD)\]\s*$/i, ''));
}

function noteTotal(chart = {}) {
  return (Array.isArray(chart.notes) ? chart.notes : []).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function flattenDivingFishCharts(songs = []) {
  const rows = [];
  for (const song of Array.isArray(songs) ? songs : []) {
    const chartType = normalizeChartType(song.type);
    const charts = Array.isArray(song.charts) ? song.charts : [];
    for (let difficultyIndex = 0; difficultyIndex < charts.length; difficultyIndex += 1) {
      const chart = charts[difficultyIndex] || {};
      rows.push({
        chartKey: `df:${song.id}:${chartType}:${difficultyIndex}`,
        musicId: String(song.id || ''),
        title: String(song.title || song.basic_info?.title || ''),
        normalizedTitle: normalizeSongTitle(song.title || song.basic_info?.title || ''),
        chartType,
        difficultyIndex,
        difficultyName: DIFFICULTY_NAMES[difficultyIndex] || `Difficulty ${difficultyIndex}`,
        level: String(song.level?.[difficultyIndex] || ''),
        constant: Number(song.ds?.[difficultyIndex] || 0),
        noteTotal: noteTotal(chart),
        charter: String(chart.charter || '')
      });
    }
  }
  return rows;
}

function noteRatio(left = 0, right = 0) {
  const max = Math.max(Number(left) || 0, Number(right) || 0);
  if (max <= 0) return 1;
  return Math.abs((Number(left) || 0) - (Number(right) || 0)) / max;
}

function candidateScore(source = {}, target = {}) {
  let score = 0.55 + 0.15 + 0.1;
  const ratio = noteRatio(source.noteTotal, target.noteTotal);
  if (ratio === 0) score += 0.15;
  else if (ratio <= 0.01) score += 0.12;
  if (normalizeCharter(source.charter) && normalizeCharter(source.charter) === normalizeCharter(target.charter)) score += 0.05;
  if (String(source.sourceId || '') === String(target.musicId || '')) score += 0.02;
  return Math.min(1, score);
}

function mapSourceCharts(songs = [], sourceCharts = []) {
  const targets = flattenDivingFishCharts(songs);
  return (Array.isArray(sourceCharts) ? sourceCharts : []).map((source) => {
    const sourceTitle = normalizeSourceTitle(source.title);
    const sourceType = normalizeChartType(source.chartType);
    const sourceDifficulty = Number(source.difficultyIndex);
    const candidates = targets
      .filter((target) => target.normalizedTitle === sourceTitle)
      .filter((target) => target.chartType === sourceType)
      .filter((target) => target.difficultyIndex === sourceDifficulty)
      .filter((target) => noteRatio(source.noteTotal, target.noteTotal) <= 0.01)
      .map((target) => ({ target, score: candidateScore(source, target) }))
      .sort((left, right) => right.score - left.score || left.target.chartKey.localeCompare(right.target.chartKey));
    const best = candidates[0] || null;
    const runnerUp = candidates[1] || null;
    const margin = best ? best.score - (runnerUp?.score || 0) : 0;
    const confirmed = Boolean(best && best.score >= 0.88 && (!runnerUp || margin >= 0.08));
    return {
      sourceChartKey: String(source.sourceChartKey || ''),
      chartKey: confirmed ? best.target.chartKey : '',
      contentHash: String(source.contentHash || ''),
      status: confirmed ? 'confirmed' : 'quarantined',
      confidence: best?.score || 0,
      margin,
      reason: confirmed
        ? 'title_type_difficulty_notes_unique'
        : (!best ? 'no_hard_match' : 'ambiguous_match'),
      candidates: candidates.slice(0, 5).map((candidate) => ({
        chartKey: candidate.target.chartKey,
        score: candidate.score
      }))
    };
  });
}

module.exports = {
  DIFFICULTY_NAMES,
  flattenDivingFishCharts,
  mapSourceCharts,
  normalizeChartType,
  normalizeSourceTitle,
  noteTotal,
  noteRatio
};

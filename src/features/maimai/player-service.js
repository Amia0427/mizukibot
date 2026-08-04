const { inferPlayerWeaknesses } = require('./player-analysis');

const DEFAULT_RECORDS_URL = 'https://www.diving-fish.com/api/maimaidxprober/player/records';
const MIN_MAPPING_CONFIDENCE = 0.88;

function normalizeChartType(value = '') {
  return String(value || '').trim().toUpperCase() === 'DX' ? 'DX' : 'SD';
}

function createMaimaiPlayerService(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const recordsUrl = String(options.recordsUrl || DEFAULT_RECORDS_URL);
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  async function fetchRecords(token) {
    const response = await fetchImpl(recordsUrl, {
      headers: { Accept: 'application/json', 'Import-Token': String(token || '') }
    });
    if (!response.ok) throw new Error('maimai player records request failed');
    const body = typeof response.json === 'function' ? await response.json() : response.body;
    const records = Array.isArray(body) ? body : (Array.isArray(body?.records) ? body.records : []);
    return { raw: body, records };
  }

  function normalizeRecord(record = {}) {
    const musicId = String(record.song_id ?? record.music_id ?? record.id ?? '').trim();
    const difficultyIndex = Number(record.level_index ?? record.difficulty_index ?? record.levelIndex);
    const chartType = normalizeChartType(record.type ?? record.chart_type);
    const achievement = Number(record.achievements ?? record.achievement ?? 0);
    return {
      chartKey: musicId && Number.isInteger(difficultyIndex) ? `df:${musicId}:${chartType}:${difficultyIndex}` : '',
      musicId,
      chartType,
      difficultyIndex,
      title: String(record.title || '').trim(),
      achievement,
      performanceZ: Number.isFinite(Number(record.performance_z ?? record.performanceZ)) ? Number(record.performance_z ?? record.performanceZ) : null,
      features: {},
      source: record
    };
  }

  function enrichRecords(records, catalog) {
    return records.map((record) => {
      const normalized = normalizeRecord(record);
      const chart = normalized.chartKey ? catalog?.getChartByKey?.(normalized.chartKey) : null;
      if (!chart || Number(chart.mappingConfidence ?? 1) < MIN_MAPPING_CONFIDENCE) return null;
      const performanceZ = normalized.performanceZ ?? (
        Number(chart.statsStdDev) > 0 ? (normalized.achievement - Number(chart.statsAvg || 0)) / Number(chart.statsStdDev) : null
      );
      return {
        ...normalized,
        performanceZ,
        mappingConfidence: Number(chart.mappingConfidence ?? 1),
        features: {
          density: Number(chart.density || 0),
          peakDensity: Number(chart.peakDensity || 0),
          chordIntensity: Number(chart.chordCount || 0),
          interactionIntensity: Number(chart.interactionCount || 0),
          verticalStreamIntensity: Number(chart.verticalStreamCount || 0),
          slideIntensity: Number(chart.slideComboCount || 0),
          touchIntensity: Number(chart.noteCounts?.touch || 0),
          breakIntensity: Number(chart.noteCounts?.break || 0),
          bpmChangeIntensity: Number(chart.bpmChangeCount || 0)
        }
      };
    }).filter(Boolean);
  }

  async function bind(userId, token, context = {}) {
    const fetched = await fetchRecords(token);
    context.playerStore.saveCredential(userId, token);
    const records = enrichRecords(fetched.records, context.catalog);
    const weaknesses = inferPlayerWeaknesses(records);
    const fetchedAt = new Date().toISOString();
    context.playerStore.saveSnapshot(userId, { fetchedAt, raw: fetched.raw, records, weaknesses: weaknesses.items });
    return { ok: true, recordCount: records.length, fetchedAt, weaknessStatus: weaknesses.status };
  }

  async function refresh(userId, context = {}) {
    const token = context.playerStore.getCredentialToken(userId);
    const fetched = await fetchRecords(token);
    const records = enrichRecords(fetched.records, context.catalog);
    const weaknesses = inferPlayerWeaknesses(records);
    const fetchedAt = new Date().toISOString();
    context.playerStore.saveSnapshot(userId, { fetchedAt, raw: fetched.raw, records, weaknesses: weaknesses.items });
    return { ok: true, recordCount: records.length, fetchedAt, weaknessStatus: weaknesses.status };
  }

  return { bind, enrichRecords, fetchRecords, normalizeRecord, refresh };
}

module.exports = { DEFAULT_RECORDS_URL, MIN_MAPPING_CONFIDENCE, createMaimaiPlayerService };

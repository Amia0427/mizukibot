const config = require('../../config');
const { normalizeText } = require('../memory-v3/helpers');

const lancedbDisableState = {
  worldbook: new Map()
};

function isLanceDbDimensionMismatch(reason = '') {
  const normalized = normalizeText(reason).toLowerCase();
  if (!normalized) return false;
  return /dimension/.test(normalized)
    || /no vector column found/.test(normalized)
    || /vector column.*not found/.test(normalized);
}

function buildWorldbookLanceDbDisableKey(queryEmbedding = [], options = {}) {
  return [
    normalizeText(options.lancedbTableName || options.tableName || config.MEMORY_LANCEDB_WORLDBOOK_TABLE || 'persona_worldbook_vectors'),
    Array.isArray(queryEmbedding) ? queryEmbedding.length : 0
  ].join(':');
}

function getWorldbookLanceDbDisableState(queryEmbedding = [], options = {}) {
  return lancedbDisableState.worldbook.get(buildWorldbookLanceDbDisableKey(queryEmbedding, options)) || null;
}

function markWorldbookLanceDbDisabled(queryEmbedding = [], options = {}, reason = 'dimension_mismatch') {
  const key = buildWorldbookLanceDbDisableKey(queryEmbedding, options);
  const state = {
    key,
    tableName: normalizeText(options.lancedbTableName || options.tableName || config.MEMORY_LANCEDB_WORLDBOOK_TABLE || 'persona_worldbook_vectors'),
    queryDimension: Array.isArray(queryEmbedding) ? queryEmbedding.length : 0,
    lancedbDisabledReason: reason,
    rebuildCommand: 'node scripts/sync-lancedb-memory-index.js --full --compact',
    disabledAt: Date.now()
  };
  lancedbDisableState.worldbook.set(key, state);
  return state;
}

module.exports = {
  getWorldbookLanceDbDisableState,
  isLanceDbDimensionMismatch,
  markWorldbookLanceDbDisabled
};

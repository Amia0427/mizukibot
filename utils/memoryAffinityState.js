'use strict';

const fs = require('fs');
const config = require('../config');
const {
  LEGACY_MEMORY_LIMITS,
  clampNumber,
  clampText,
  defaultFavorite
} = require('./memory/legacyState');
const {
  computeLevelFromPoints,
  enforceAdminAffinityState,
  normalizeAttitude,
  normalizeRelationship,
  resolveAffinityKey
} = require('./memory/affinity');

function readAffinityStore() {
  try {
    if (!fs.existsSync(config.DATA_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(config.DATA_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function getV3OnlyAffinityState(userId, options = {}) {
  const key = resolveAffinityKey(userId, options);
  if (!key) return defaultFavorite();
  const current = readAffinityStore()[key];
  const state = {
    ...defaultFavorite(),
    ...(current && typeof current === 'object' ? current : {})
  };
  state.points = Number(state.points || 0) || 0;
  state.level = computeLevelFromPoints(state.points);
  state.relationship = normalizeRelationship(state.relationship, state.level || '陌生人');
  state.attitude = normalizeAttitude(state.attitude, '中立、保持距离');
  state.trust_score = clampNumber(state.trust_score, -100, 100, 0);
  state.last_affinity_reason = clampText(state.last_affinity_reason, LEGACY_MEMORY_LIMITS.affinityReasonLength);
  state.last_affinity_source = clampText(state.last_affinity_source, 32);
  state.last_affinity_update_at = Math.max(0, Number(state.last_affinity_update_at || 0) || 0);
  state.scope = 'global';
  return enforceAdminAffinityState(key, state);
}

function getUserAffinityState(userId, options = {}) {
  if (config.CONVERSATION_VARIABLES_ENABLED !== false && config.CONVERSATION_VARIABLES_PRIMARY_READ !== false) {
    const key = resolveAffinityKey(userId, options);
    const variables = require('./conversationVariables');
    if (variables.hasState(key)) {
      return variables.toLegacyAffinityState(variables.getSnapshot({ userId: key }), key);
    }
  }
  if (config.MEMORY_STORAGE_MODE === 'v3_only') {
    return getV3OnlyAffinityState(userId, options);
  }
  return require('./memory').getUserAffinityState(userId, options);
}

module.exports = {
  getUserAffinityState
};

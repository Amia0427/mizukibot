'use strict';

const SCOPE_TYPES = Object.freeze({
  USER: 'user',
  GLOBAL: 'global'
});

const GLOBAL_SCOPE_ID = 'mizuki';
const LONG_ABSENCE_MS = 30 * 24 * 60 * 60 * 1000;
const BOUNDARY_MODES = Object.freeze(['guarded', 'cautious', 'comfortable', 'close']);
const BOUNDARY_LABELS = Object.freeze({
  guarded: '保持边界',
  cautious: '谨慎接近',
  comfortable: '相处自然',
  close: '可以亲近'
});
const STAGE_LABELS = Object.freeze({
  stranger: '陌生人',
  acquaintance: '初识',
  friend: '普通朋友',
  close: '亲近朋友',
  intimate_companion: '亲密伙伴'
});
const STAGE_DESCRIPTIONS = Object.freeze({
  stranger: '还在保持礼貌距离，慢慢认识就好。',
  acquaintance: '已经认识了，可以自然聊聊天。',
  friend: '是普通朋友，会愿意认真接住彼此的话。',
  close: '关系比较亲近，会分享更多真实的感受。',
  intimate_companion: '是很重要的亲密伙伴，但仍然保留彼此的边界。'
});

const VARIABLE_DEFINITIONS = Object.freeze({
  affection: Object.freeze({ scopeType: SCOPE_TYPES.USER, type: 'number', min: 0, max: 100, defaultValue: 0 }),
  trust: Object.freeze({ scopeType: SCOPE_TYPES.USER, type: 'number', min: 0, max: 100, defaultValue: 0 }),
  familiarity: Object.freeze({ scopeType: SCOPE_TYPES.USER, type: 'number', min: 0, max: 100, defaultValue: 0 }),
  boundaryMode: Object.freeze({ scopeType: SCOPE_TYPES.USER, type: 'enum', values: BOUNDARY_MODES, defaultValue: 'guarded' }),
  attitude: Object.freeze({ scopeType: SCOPE_TYPES.USER, type: 'text', maxLength: 120, defaultValue: '中立、保持距离' }),
  lastInteractionAt: Object.freeze({ scopeType: SCOPE_TYPES.USER, type: 'number', min: 0, max: Number.MAX_SAFE_INTEGER, defaultValue: 0 }),
  mood: Object.freeze({ scopeType: SCOPE_TYPES.GLOBAL, type: 'number', min: -100, max: 100, defaultValue: 0, baseline: 0, decayPerHour: 4 }),
  energy: Object.freeze({ scopeType: SCOPE_TYPES.GLOBAL, type: 'number', min: 0, max: 100, defaultValue: 60, baseline: 60, decayPerHour: 5 }),
  stress: Object.freeze({ scopeType: SCOPE_TYPES.GLOBAL, type: 'number', min: 0, max: 100, defaultValue: 20, baseline: 20, decayPerHour: 3 }),
  socialWillingness: Object.freeze({ scopeType: SCOPE_TYPES.GLOBAL, type: 'number', min: 0, max: 100, defaultValue: 60, baseline: 60, decayPerHour: 3 }),
  boundary_mode: Object.freeze({ scopeType: SCOPE_TYPES.USER, type: 'enum', values: BOUNDARY_MODES, defaultValue: 'guarded', aliasOf: 'boundaryMode' }),
  last_interaction_at: Object.freeze({ scopeType: SCOPE_TYPES.USER, type: 'number', min: 0, max: Number.MAX_SAFE_INTEGER, defaultValue: 0, aliasOf: 'lastInteractionAt' }),
  social_willingness: Object.freeze({ scopeType: SCOPE_TYPES.GLOBAL, type: 'number', min: 0, max: 100, defaultValue: 60, baseline: 60, decayPerHour: 3, aliasOf: 'socialWillingness' })
});

function canonicalVariableKey(key) {
  const normalized = String(key || '').trim();
  return VARIABLE_DEFINITIONS[normalized]?.aliasOf || normalized;
}

const DEFAULT_RELATIONSHIP_STATE = Object.freeze({
  affection: 0,
  trust: 0,
  familiarity: 0,
  boundaryMode: '',
  attitude: '中立、保持距离',
  lastInteractionAt: null
});

const DEFAULT_CHARACTER_STATE = Object.freeze({
  mood: 0,
  energy: 60,
  stress: 20,
  socialWillingness: 60
});

function normalizeText(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function roundValue(value) {
  return Math.round(Number(value) * 100) / 100;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return roundValue(Math.max(min, Math.min(max, number)));
}

function normalizeVariableValue(key, value) {
  const canonicalKey = canonicalVariableKey(key);
  const definition = VARIABLE_DEFINITIONS[canonicalKey];
  if (!definition) return undefined;
  if (definition.type === 'number') {
    return clampNumber(value, definition.min, definition.max, definition.defaultValue);
  }
  if (definition.type === 'enum') {
    const normalized = normalizeText(value, 32);
    return definition.values.includes(normalized) ? normalized : definition.defaultValue;
  }
  return normalizeText(value, definition.maxLength) || definition.defaultValue;
}

function stageScore(state = {}) {
  return roundValue(
    Number(state.affection || 0) * 0.45
    + Number(state.trust || 0) * 0.35
    + Number(state.familiarity || 0) * 0.2
  );
}

function deriveStage(state = {}) {
  const affection = Number(state.affection || 0);
  const trust = Number(state.trust || 0);
  const familiarity = Number(state.familiarity || 0);
  const score = stageScore(state);
  if (score >= 82 && trust >= 70 && familiarity >= 65) return 'intimate_companion';
  if (score >= 65 && trust >= 50 && familiarity >= 45) return 'close';
  if (score >= 40 && trust >= 30 && familiarity >= 25) return 'friend';
  if (score >= 18 || familiarity >= 15 || affection >= 20 || trust >= 20) return 'acquaintance';
  return 'stranger';
}

function deriveBoundaryMode(state = {}) {
  const trust = Number(state.trust || 0);
  const familiarity = Number(state.familiarity || 0);
  if (trust >= 70 && familiarity >= 65) return 'close';
  if (trust >= 45 && familiarity >= 30) return 'comfortable';
  if (trust >= 20 || familiarity >= 15) return 'cautious';
  return 'guarded';
}

function normalizeRelationshipState(state = {}) {
  const boundaryMode = state.boundaryMode ?? state.boundary_mode;
  const lastInteractionAt = state.lastInteractionAt ?? state.last_interaction_at;
  const relationship = {
    affection: normalizeVariableValue('affection', state.affection),
    trust: normalizeVariableValue('trust', state.trust),
    familiarity: normalizeVariableValue('familiarity', state.familiarity),
    boundaryMode: BOUNDARY_MODES.includes(boundaryMode) ? boundaryMode : deriveBoundaryMode(state),
    attitude: normalizeVariableValue('attitude', state.attitude),
    lastInteractionAt: Number(lastInteractionAt || 0) > 0 ? Number(lastInteractionAt) : null
  };
  const stage = deriveStage(relationship);
  return {
    ...relationship,
    stage,
    stageLabel: STAGE_LABELS[stage],
    stageDescription: STAGE_DESCRIPTIONS[stage],
    boundaryLabel: BOUNDARY_LABELS[relationship.boundaryMode],
    boundary_mode: relationship.boundaryMode,
    last_interaction_at: relationship.lastInteractionAt,
    score: stageScore(relationship)
  };
}

function normalizeCharacterState(state = {}) {
  const socialWillingness = state.socialWillingness ?? state.social_willingness;
  return {
    mood: normalizeVariableValue('mood', state.mood),
    energy: normalizeVariableValue('energy', state.energy),
    stress: normalizeVariableValue('stress', state.stress),
    socialWillingness: normalizeVariableValue('socialWillingness', socialWillingness),
    social_willingness: normalizeVariableValue('socialWillingness', socialWillingness)
  };
}

function characterBaseline() {
  return { ...DEFAULT_CHARACTER_STATE };
}

function decayCharacterState(state = {}, elapsedMs = 0) {
  const hours = Math.max(0, Number(elapsedMs || 0) / 3600000);
  if (hours <= 0) return normalizeCharacterState(state);
  const baseline = characterBaseline();
  const output = {};
  for (const key of ['mood', 'energy', 'stress', 'socialWillingness']) {
    const definition = VARIABLE_DEFINITIONS[key];
    const current = Number(state[key] ?? definition.defaultValue);
    const target = Number(baseline[key] ?? definition.baseline);
    const distance = target - current;
    const movement = Math.min(Math.abs(distance), definition.decayPerHour * hours);
    output[key] = normalizeVariableValue(key, current + Math.sign(distance) * movement);
  }
  return output;
}

function moveBoundaryMode(current, signal) {
  const index = Math.max(0, BOUNDARY_MODES.indexOf(current));
  if (signal === 'closer') return BOUNDARY_MODES[Math.min(BOUNDARY_MODES.length - 1, index + 1)];
  if (signal === 'farther') return BOUNDARY_MODES[Math.max(0, index - 1)];
  return BOUNDARY_MODES[index] || 'guarded';
}

module.exports = {
  BOUNDARY_LABELS,
  BOUNDARY_MODES,
  DEFAULT_CHARACTER_STATE,
  DEFAULT_RELATIONSHIP_STATE,
  GLOBAL_SCOPE_ID,
  LONG_ABSENCE_MS,
  SCOPE_TYPES,
  STAGE_DESCRIPTIONS,
  STAGE_LABELS,
  VARIABLE_DEFINITIONS,
  characterBaseline,
  clampNumber,
  decayCharacterState,
  deriveBoundaryMode,
  deriveStage,
  moveBoundaryMode,
  normalizeCharacterState,
  normalizeRelationshipState,
  normalizeText,
  normalizeVariableValue,
  canonicalVariableKey,
  stageScore
};

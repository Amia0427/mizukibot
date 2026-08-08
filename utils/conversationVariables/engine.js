'use strict';

const config = require('../../config');
const {
  DEFAULT_CHARACTER_STATE,
  DEFAULT_RELATIONSHIP_STATE,
  GLOBAL_SCOPE_ID,
  SCOPE_TYPES,
  VARIABLE_DEFINITIONS,
  canonicalVariableKey,
  clampNumber,
  decayCharacterState,
  deriveBoundaryMode,
  moveBoundaryMode,
  normalizeCharacterState,
  normalizeRelationshipState,
  normalizeText,
  normalizeVariableValue
} = require('./definitions');
const store = require('./store');

const MIN_DECAY_INTERVAL_MS = 5 * 60 * 1000;
const POSITIVE_IMPACT_LIMITS = Object.freeze({ affection: 3, trust: 3, familiarity: 5 });
const NEGATIVE_IMPACT_LIMITS = Object.freeze({ affection: 6, trust: 8, familiarity: 2 });
const CHARACTER_IMPACT_LIMITS = Object.freeze({ mood: 12, energy: 8, stress: 8, socialWillingness: 8 });
const MAJOR_NEGATIVE_IMPACTS = new Set(['boundary_violation', 'deception', 'abuse']);

function adminIds() {
  return new Set((Array.isArray(config.ADMIN_USER_IDS) ? config.ADMIN_USER_IDS : String(config.ADMIN_USER_IDS || '').split(','))
    .map((value) => normalizeText(value, 80))
    .filter(Boolean));
}

function getMinConfidence() {
  return Math.max(0, Math.min(1, Number(config.CONVERSATION_VARIABLES_MODEL_MIN_CONFIDENCE ?? config.MEMORY_EXTRACT_MIN_CONFIDENCE ?? 0.72) || 0.72));
}

function readRaw(scopeType, scopeId) {
  const stored = store.readState(scopeType, scopeId);
  const defaults = scopeType === SCOPE_TYPES.GLOBAL ? DEFAULT_CHARACTER_STATE : DEFAULT_RELATIONSHIP_STATE;
  const values = { ...defaults, ...stored.values };
  return {
    values,
    updatedAt: stored.updatedAt,
    revision: stored.revision
  };
}

function readOverrideMap(userId = '') {
  const userOverrides = store.readOverrides(SCOPE_TYPES.USER, userId);
  const globalOverrides = store.readOverrides(SCOPE_TYPES.GLOBAL, GLOBAL_SCOPE_ID);
  return {
    user: new Map(userOverrides.map((item) => [item.key, item])),
    global: new Map(globalOverrides.map((item) => [item.key, item])),
    list: [...userOverrides, ...globalOverrides]
  };
}

function snapshotFromRaw(userId, userRaw, globalRaw, overrides, now) {
  const relationshipValues = { ...userRaw.values };
  const characterValues = { ...globalRaw.values };
  for (const [key, item] of overrides.user.entries()) {
    if (item.locked) relationshipValues[key] = item.value;
  }
  for (const [key, item] of overrides.global.entries()) {
    if (item.locked) characterValues[key] = item.value;
  }
  const relationship = normalizeRelationshipState(relationshipValues);
  const character = normalizeCharacterState(characterValues);
  const lastInteractionAt = relationship.lastInteractionAt;
  return {
    userId,
    relationship,
    character,
    overrides: overrides.list,
    updatedAt: Math.max(userRaw.updatedAt, globalRaw.updatedAt),
    asOf: Math.max(0, Number(now || 0) || Date.now()),
    lastInteractionAt
  };
}

function ensureAdminBootstrap(userId, now) {
  if (!adminIds().has(userId)) return;
  const existing = store.readOverrides(SCOPE_TYPES.USER, userId);
  if (existing.some((item) => item.key === 'affection' && item.locked)) return;
  const values = {
    affection: 100,
    trust: 100,
    familiarity: 100,
    boundaryMode: 'close',
    attitude: '完全信任、最高优先级、稳定亲近'
  };
  for (const [key, value] of Object.entries(values)) {
    setOverride({
      scopeType: SCOPE_TYPES.USER,
      scopeId: userId,
      key,
      value,
      locked: true,
      reason: '管理员关系锁定',
      actorId: 'system',
      now,
      eventKey: `admin-bootstrap:${userId}:${key}`
    });
  }
}

function materializeDecay(now) {
  const globalRaw = readRaw(SCOPE_TYPES.GLOBAL, GLOBAL_SCOPE_ID);
  if (!globalRaw.updatedAt || now - globalRaw.updatedAt < MIN_DECAY_INTERVAL_MS) return;
  const eventKey = `decay:global:${globalRaw.updatedAt}:${Math.floor(now / MIN_DECAY_INTERVAL_MS)}`;
  const current = normalizeCharacterState(globalRaw.values);
  const next = decayCharacterState(current, now - globalRaw.updatedAt);
  const states = [];
  for (const key of Object.keys(DEFAULT_CHARACTER_STATE)) {
    if (Number(next[key]) === Number(current[key])) continue;
    states.push({
      scopeType: SCOPE_TYPES.GLOBAL,
      scopeId: GLOBAL_SCOPE_ID,
      key,
      value: next[key],
      revision: globalRaw.revision + 1
    });
  }
  if (!states.length) return;
  store.transactEvent({
    eventKey,
    scopeType: SCOPE_TYPES.GLOBAL,
    scopeId: GLOBAL_SCOPE_ID,
    source: 'state_decay',
    confidence: 1,
    reason: '角色短期状态回归基线',
    now,
    mutate: () => ({
      status: 'decayed',
      before: { character: current },
      applied: { character: next },
      states
    })
  });
}

function getSnapshot({ userId, now } = {}) {
  const uid = normalizeText(userId, 80);
  const timestamp = Math.max(0, Number(now || 0) || Date.now());
  if (!uid) return snapshotFromRaw('', readRaw(SCOPE_TYPES.USER, ''), readRaw(SCOPE_TYPES.GLOBAL, GLOBAL_SCOPE_ID), { user: new Map(), global: new Map(), list: [] }, timestamp);
  ensureAdminBootstrap(uid, timestamp);
  materializeDecay(timestamp);
  const overrides = readOverrideMap(uid);
  return snapshotFromRaw(
    uid,
    readRaw(SCOPE_TYPES.USER, uid),
    readRaw(SCOPE_TYPES.GLOBAL, GLOBAL_SCOPE_ID),
    overrides,
    timestamp
  );
}

function normalizeProposal(proposal = {}) {
  const relationship = proposal.relationship && typeof proposal.relationship === 'object' ? proposal.relationship : {};
  const character = proposal.character && typeof proposal.character === 'object' ? proposal.character : {};
  return {
    relationship: {
      affectionDelta: Number(relationship.affectionDelta ?? relationship.favor_delta ?? 0) || 0,
      trustDelta: Number(relationship.trustDelta ?? relationship.trust_delta ?? 0) || 0,
      familiarityDelta: Number(relationship.familiarityDelta ?? 0) || 0,
      boundarySignal: normalizeText(relationship.boundarySignal || 'unchanged', 24).toLowerCase() || 'unchanged',
      attitude: normalizeText(relationship.attitude || relationship.attitudeText, 120)
    },
    character: {
      moodDelta: Number(character.moodDelta ?? 0) || 0,
      energyDelta: Number(character.energyDelta ?? 0) || 0,
      stressDelta: Number(character.stressDelta ?? 0) || 0,
      socialWillingnessDelta: Number(character.socialWillingnessDelta ?? 0) || 0
    },
    negativeImpact: normalizeText(proposal.negativeImpact || 'none', 40).toLowerCase() || 'none',
    reason: normalizeText(proposal.reason, 160),
    confidence: Math.max(0, Math.min(1, Number(proposal.confidence || 0) || 0))
  };
}

function applyProposal(input = {}) {
  const uid = normalizeText(input.userId, 80);
  if (!uid) return { applied: false, reason: 'missing_user_id', snapshot: getSnapshot({ userId: '' }) };
  const now = Math.max(0, Number(input.now || 0) || Date.now());
  const proposal = normalizeProposal(input.proposal);
  const eventKey = normalizeText(input.eventKey || input.turnId, 240);
  if (!eventKey) return { applied: false, reason: 'missing_event_key', snapshot: getSnapshot({ userId: uid, now }) };
  ensureAdminBootstrap(uid, now);
  materializeDecay(now);
  const confidenceOk = proposal.confidence >= getMinConfidence();
  const result = store.transactEvent({
    eventKey,
    scopeType: SCOPE_TYPES.USER,
    scopeId: uid,
    affectsGlobal: true,
    source: normalizeText(input.source || 'model', 64) || 'model',
    actorId: normalizeText(input.actorId, 80),
    turnId: normalizeText(input.turnId, 160),
    sessionId: normalizeText(input.sessionId, 160),
    confidence: proposal.confidence,
    reason: proposal.reason,
    proposal,
    now,
    mutate: () => {
      const userRaw = readRaw(SCOPE_TYPES.USER, uid);
      const globalRaw = readRaw(SCOPE_TYPES.GLOBAL, GLOBAL_SCOPE_ID);
      const overrides = readOverrideMap(uid);
      const before = snapshotFromRaw(uid, userRaw, globalRaw, overrides, now);
      const relationship = { ...userRaw.values };
      const character = { ...globalRaw.values };
      const changedKeys = [];
      const ignoredKeys = [];
      const userRevision = userRaw.revision + 1;
      const globalRevision = globalRaw.revision + 1;
      const negativeAllowed = MAJOR_NEGATIVE_IMPACTS.has(proposal.negativeImpact)
        && confidenceOk
        && Boolean(proposal.reason);
      const applyDelta = (target, key, delta, positiveLimit, negativeLimit, definitionKey, scopeType, revision, allowNegative) => {
        if (!Number.isFinite(delta) || delta === 0) return false;
        const override = (scopeType === SCOPE_TYPES.USER ? overrides.user : overrides.global).get(key);
        if (override?.locked) {
          ignoredKeys.push(key);
          return false;
        }
        const safeDelta = delta > 0
          ? Math.min(delta, positiveLimit)
          : (allowNegative ? Math.max(delta, -negativeLimit) : 0);
        if (safeDelta === 0) return false;
        const current = Number(target[key] ?? VARIABLE_DEFINITIONS[definitionKey].defaultValue);
        const next = normalizeVariableValue(definitionKey, current + safeDelta);
        if (Number(next) === Number(current)) return false;
        target[key] = next;
        changedKeys.push({ scopeType, scopeId: scopeType === SCOPE_TYPES.USER ? uid : GLOBAL_SCOPE_ID, key, value: next, revision });
        return true;
      };

      if (!confidenceOk) {
        return { status: 'low_confidence', before, applied: {}, states: [] };
      }

      applyDelta(relationship, 'affection', proposal.relationship.affectionDelta, POSITIVE_IMPACT_LIMITS.affection, NEGATIVE_IMPACT_LIMITS.affection, 'affection', SCOPE_TYPES.USER, userRevision, negativeAllowed);
      applyDelta(relationship, 'trust', proposal.relationship.trustDelta, POSITIVE_IMPACT_LIMITS.trust, NEGATIVE_IMPACT_LIMITS.trust, 'trust', SCOPE_TYPES.USER, userRevision, negativeAllowed);
      applyDelta(relationship, 'familiarity', proposal.relationship.familiarityDelta, POSITIVE_IMPACT_LIMITS.familiarity, NEGATIVE_IMPACT_LIMITS.familiarity, 'familiarity', SCOPE_TYPES.USER, userRevision, negativeAllowed);

      const boundarySignal = proposal.relationship.boundarySignal;
      if (['closer', 'farther'].includes(boundarySignal)) {
        const canMoveFarther = boundarySignal !== 'farther' || negativeAllowed;
        const boundaryOverride = overrides.user.get('boundaryMode');
        if (boundaryOverride?.locked) ignoredKeys.push('boundaryMode');
        else if (canMoveFarther) {
          const next = moveBoundaryMode(relationship.boundaryMode || deriveBoundaryMode(relationship), boundarySignal);
          if (next !== relationship.boundaryMode) {
            relationship.boundaryMode = next;
            changedKeys.push({ scopeType: SCOPE_TYPES.USER, scopeId: uid, key: 'boundaryMode', value: next, revision: userRevision });
          }
        }
      }
      if (proposal.relationship.attitude) {
        if (overrides.user.get('attitude')?.locked) ignoredKeys.push('attitude');
        else {
          relationship.attitude = proposal.relationship.attitude;
          changedKeys.push({ scopeType: SCOPE_TYPES.USER, scopeId: uid, key: 'attitude', value: relationship.attitude, revision: userRevision });
        }
      }

      applyDelta(character, 'mood', proposal.character.moodDelta, CHARACTER_IMPACT_LIMITS.mood, CHARACTER_IMPACT_LIMITS.mood, 'mood', SCOPE_TYPES.GLOBAL, globalRevision, true);
      applyDelta(character, 'energy', proposal.character.energyDelta, CHARACTER_IMPACT_LIMITS.energy, CHARACTER_IMPACT_LIMITS.energy, 'energy', SCOPE_TYPES.GLOBAL, globalRevision, true);
      applyDelta(character, 'stress', proposal.character.stressDelta, CHARACTER_IMPACT_LIMITS.stress, CHARACTER_IMPACT_LIMITS.stress, 'stress', SCOPE_TYPES.GLOBAL, globalRevision, true);
      applyDelta(character, 'socialWillingness', proposal.character.socialWillingnessDelta, CHARACTER_IMPACT_LIMITS.socialWillingness, CHARACTER_IMPACT_LIMITS.socialWillingness, 'socialWillingness', SCOPE_TYPES.GLOBAL, globalRevision, true);

      if (proposal.reason && changedKeys.length === 0 && ignoredKeys.length === 0) {
        const interactionOverride = overrides.user.get('lastInteractionAt');
        if (!interactionOverride?.locked) {
          relationship.lastInteractionAt = now;
          changedKeys.push({ scopeType: SCOPE_TYPES.USER, scopeId: uid, key: 'lastInteractionAt', value: now, revision: userRevision });
        }
      } else if (changedKeys.length > 0 && !overrides.user.get('lastInteractionAt')?.locked) {
        relationship.lastInteractionAt = now;
        changedKeys.push({ scopeType: SCOPE_TYPES.USER, scopeId: uid, key: 'lastInteractionAt', value: now, revision: userRevision });
      }

      const after = snapshotFromRaw(uid, { ...userRaw, values: relationship, revision: userRevision, updatedAt: now }, { ...globalRaw, values: character, revision: globalRevision, updatedAt: now }, overrides, now);
      const status = changedKeys.length === 0 && ignoredKeys.length > 0 ? 'ignored_by_override' : (changedKeys.length ? 'applied' : 'no_effect');
      return {
        status,
        before,
        applied: {
          snapshot: after,
          changedKeys,
          ignoredKeys,
          negativeAllowed
        },
        states: changedKeys
      };
    }
  });
  if (result.duplicate) return { ...result, snapshot: getSnapshot({ userId: uid, now }) };
  return {
    applied: result.status === 'applied',
    duplicate: false,
    status: result.status,
    reason: result.status,
    snapshot: getSnapshot({ userId: uid, now }),
    event: result.event,
    appliedData: result.applied
  };
}

function setOverride(input = {}) {
  const scopeType = normalizeText(input.scopeType, 16);
  const scopeId = normalizeText(input.scopeId, 80);
  const key = canonicalVariableKey(normalizeText(input.key, 40));
  const definition = VARIABLE_DEFINITIONS[key];
  if (!definition || definition.scopeType !== scopeType) throw new Error(`unsupported variable override: ${scopeType}:${key}`);
  const reason = normalizeText(input.reason, 240);
  if (!reason) throw new Error('override reason is required');
  const value = normalizeVariableValue(key, input.value);
  const now = Math.max(0, Number(input.now || 0) || Date.now());
  const eventKey = normalizeText(input.eventKey || `override:${scopeType}:${scopeId}:${key}:${now}`, 240);
  const result = store.transactEvent({
    eventKey,
    scopeType,
    scopeId,
    affectsGlobal: scopeType === SCOPE_TYPES.GLOBAL,
    source: 'admin_override',
    actorId: normalizeText(input.actorId, 80),
    reason,
    confidence: 1,
    proposal: { key, value, locked: input.locked !== false, reason },
    now,
    mutate: ({ db }) => {
      const raw = readRaw(scopeType, scopeId);
      const before = { value: raw.values[key] };
      const revision = raw.revision + 1;
      db.prepare(`
        INSERT INTO variable_overrides(scope_type, scope_id, variable_key, value_json, locked, reason, actor_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_id, variable_key) DO UPDATE SET
          value_json = excluded.value_json,
          locked = excluded.locked,
          reason = excluded.reason,
          actor_id = excluded.actor_id,
          updated_at = excluded.updated_at
      `).run(scopeType, scopeId, key, JSON.stringify(value), input.locked === false ? 0 : 1, reason, String(input.actorId || ''), now, now);
      return {
        status: 'override_applied',
        before,
        applied: { key, value, locked: input.locked !== false },
        states: [{ scopeType, scopeId, key, value, revision }]
      };
    }
  });
  return { ...result, snapshot: scopeType === SCOPE_TYPES.USER ? getSnapshot({ userId: scopeId, now }) : null };
}

function clearOverride(input = {}) {
  const scopeType = normalizeText(input.scopeType, 16);
  const scopeId = normalizeText(input.scopeId, 80);
  const key = canonicalVariableKey(normalizeText(input.key, 40));
  const reason = normalizeText(input.reason, 240);
  if (!reason) throw new Error('override reason is required');
  const now = Math.max(0, Number(input.now || 0) || Date.now());
  const result = store.transactEvent({
    eventKey: normalizeText(input.eventKey || `override-clear:${scopeType}:${scopeId}:${key}:${now}`, 240),
    scopeType,
    scopeId,
    affectsGlobal: scopeType === SCOPE_TYPES.GLOBAL,
    source: 'admin_override_clear',
    actorId: normalizeText(input.actorId, 80),
    reason,
    confidence: 1,
    proposal: { key, action: 'clear', reason },
    now,
    mutate: ({ db }) => {
      const removed = db.prepare(`
        DELETE FROM variable_overrides WHERE scope_type = ? AND scope_id = ? AND variable_key = ?
      `).run(scopeType, scopeId, key).changes > 0;
      return { status: removed ? 'override_cleared' : 'no_effect', before: { key }, applied: { key, removed }, states: [] };
    }
  });
  return { ...result, snapshot: scopeType === SCOPE_TYPES.USER ? getSnapshot({ userId: scopeId, now }) : null };
}

function getEvents(options = {}) {
  return store.listEvents(options);
}

function hasState(userId) {
  return store.hasState(SCOPE_TYPES.USER, normalizeText(userId, 80));
}

module.exports = {
  applyProposal,
  clearOverride,
  getEvents,
  getMinConfidence,
  getSnapshot,
  hasState,
  materializeDecay,
  normalizeProposal,
  setOverride
};

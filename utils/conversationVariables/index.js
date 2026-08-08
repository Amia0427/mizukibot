'use strict';

const config = require('../../config');
const engine = require('./engine');
const format = require('./format');
const prompt = require('./prompt');
const query = require('./query');
const migration = require('./migration');
const store = require('./store');

function isEnabled() {
  return config.CONVERSATION_VARIABLES_ENABLED !== false;
}

function applyLegacyAffinityProposal(userId, proposal = {}, options = {}) {
  if (!isEnabled()) return null;
  const relationship = proposal && typeof proposal === 'object' ? proposal : {};
  const relationshipPayload = relationship.relationship && typeof relationship.relationship === 'object'
    ? relationship.relationship
    : relationship;
  const result = engine.applyProposal({
    userId,
    eventKey: options.eventKey || options.turnId || options.jobId || options.postReplyJobId,
    turnId: options.turnId,
    sessionId: options.sessionId,
    source: options.source || 'affinity_extractor',
    proposal: {
      relationship: {
        affectionDelta: relationshipPayload.affectionDelta ?? relationshipPayload.favor_delta,
        trustDelta: relationshipPayload.trustDelta ?? relationshipPayload.trust_delta,
        familiarityDelta: relationshipPayload.familiarityDelta ?? relationshipPayload.familiarity_delta,
        boundarySignal: relationshipPayload.boundarySignal ?? relationshipPayload.boundary_signal,
        attitude: relationshipPayload.attitude ?? relationshipPayload.attitudeText
      },
      character: relationship.character || {},
      negativeImpact: relationship.negativeImpact || relationship.negative_impact || 'none',
      reason: relationship.reason,
      confidence: relationship.confidence
    }
  });
  return {
    applied: result.applied,
    reason: result.reason,
    state: format.toLegacyAffinityState(result.snapshot, userId),
    proposal: relationship,
    delta: result.appliedData?.changedKeys || []
  };
}

module.exports = {
  ...engine,
  ...format,
  ...prompt,
  ...query,
  ...migration,
  applyLegacyAffinityProposal,
  closeDb: store.closeDb,
  isEnabled,
  resetDbForTests: store.resetDbForTests
};

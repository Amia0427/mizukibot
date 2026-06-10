const { buildMemoryQualityMeta, evaluateMemoryQuality } = require('../memoryQuality');

function defaultNormalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isPollutionRejectReason(reasons = []) {
  const list = Array.isArray(reasons) ? reasons : [];
  return list.some((reason) => [
    'prompt_pollution',
    'assistant_self_instruction',
    'memory_pollution',
    'bad_roleplay_refusal_reply',
    'assistant_memory_failure_reply',
    'internal_context_leak',
    'raw_model_response',
    'prompt_or_schema_pollution'
  ].includes(String(reason || '').trim()));
}

function createMemoryWriteQualityGate(deps = {}) {
  const normalizeText = typeof deps.normalizeText === 'function' ? deps.normalizeText : defaultNormalizeText;
  const mergeLearningDecisionMeta = typeof deps.mergeLearningDecisionMeta === 'function'
    ? deps.mergeLearningDecisionMeta
    : ((candidate = {}, patch = {}) => ({
      ...(candidate.meta && typeof candidate.meta === 'object' ? candidate.meta : {}),
      learningDecision: patch
    }));

  function evaluate(candidate = {}, options = {}) {
    const quality = evaluateMemoryQuality(candidate, options);
    const qualityMeta = buildMemoryQualityMeta(quality);
    if (quality.shouldReject) {
      return {
        quality,
        qualityMeta,
        rejected: {
          ok: false,
          reason: isPollutionRejectReason(quality.reasons)
            ? 'quality_reject_polluted'
            : 'quality_reject_low_signal',
          quality: qualityMeta
        }
      };
    }
    return { quality, qualityMeta, rejected: null };
  }

  function buildConflictCandidate(candidate = {}, conflict = {}, decision = {}) {
    const qualityMeta = decision.qualityMeta || {};
    return {
      ok: true,
      reason: 'conflict_candidate',
      conflictId: conflict.id,
      patch: {
        status: 'candidate',
        supersedes: [conflict.id],
        meta: {
          ...mergeLearningDecisionMeta(candidate, {
            status: 'candidate',
            reason: 'conflicts_with_existing_memory',
            validationReason: 'conflict_candidate',
            candidateOnly: true,
            conflictId: conflict.id
          }),
          quality: qualityMeta,
          traceReason: 'conflicts_with_existing_memory',
          conflictCandidate: {
            existingId: conflict.id,
            existingText: conflict.text || conflict.canonicalText || '',
            reason: 'pipeline_conflict_candidate'
          }
        }
      }
    };
  }

  function buildProfileCandidateOnly(candidate = {}, decision = {}) {
    const qualityMeta = decision.qualityMeta || {};
    return {
      ok: true,
      reason: 'candidate_only_profile_guard',
      patch: {
        status: 'candidate',
        meta: {
          ...mergeLearningDecisionMeta(candidate, {
            status: 'candidate',
            reason: 'high_risk_profile_candidate_only',
            validationReason: 'candidate_only_profile_guard',
            candidateOnly: true
          }),
          quality: qualityMeta,
          traceReason: candidate.meta?.traceReason || 'candidate_only_profile_guard'
        }
      }
    };
  }

  function buildQualityCandidate(candidate = {}, decision = {}) {
    const quality = decision.quality || {};
    if (!quality.shouldCandidate) return null;
    const qualityMeta = decision.qualityMeta || {};
    const staleReason = quality.stale?.expired === true;
    return {
      ok: true,
      reason: staleReason ? 'quality_candidate_stale' : 'quality_candidate_low_signal',
      patch: {
        status: 'candidate',
        meta: {
          ...mergeLearningDecisionMeta(candidate, {
            status: 'candidate',
            reason: staleReason ? 'quality_stale_candidate' : 'quality_low_signal_candidate',
            validationReason: staleReason ? 'quality_candidate_stale' : 'quality_candidate_low_signal',
            riskReasons: quality.reasons,
            riskLevel: quality.grade,
            candidateOnly: true
          }),
          quality: qualityMeta,
          traceReason: candidate.meta?.traceReason || (staleReason ? 'quality_candidate_stale' : 'quality_candidate_low_signal')
        }
      }
    };
  }

  function buildAccepted(candidate = {}, decision = {}) {
    const qualityMeta = decision.qualityMeta || {};
    return {
      ok: true,
      reason: 'accepted',
      patch: {
        status: candidate.status || undefined,
        meta: {
          ...mergeLearningDecisionMeta(candidate, {
            status: candidate.status || 'active',
            reason: 'accepted_by_memory_write_pipeline',
            validationReason: 'accepted',
            candidateOnly: normalizeText(candidate.status).toLowerCase() === 'candidate'
          }),
          quality: qualityMeta,
          traceReason: candidate.meta?.traceReason || 'accepted_by_memory_write_pipeline'
        }
      }
    };
  }

  return {
    buildAccepted,
    buildConflictCandidate,
    buildProfileCandidateOnly,
    buildQualityCandidate,
    evaluate
  };
}

module.exports = {
  createMemoryWriteQualityGate
};

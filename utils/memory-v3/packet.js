const config = require('../../config');
const { trimTextByTokenBudget } = require('../contextBudget');
const { normalizeText, clampText } = require('./helpers');
const { loadProfileProjection } = require('./storage');
const { buildStableProfileText } = require('../memoryProfileSurface');

function budget(name, fallback) {
  return Math.max(0, Number(config[name] || fallback) || fallback || 0);
}

function toMessage(label, text, tokenBudget) {
  const value = trimTextByTokenBudget(String(text || '').trim(), tokenBudget, 'tail');
  if (!value) return [];
  return [{ role: 'system', content: `[${label}]\n${value}` }];
}

function appendSelectionReason(existing = '', reason = '') {
  const list = String(existing || '').split(',').map((item) => normalizeText(item)).filter(Boolean);
  if (reason && !list.includes(reason)) list.push(reason);
  return list.join(',');
}

function getStrongSemanticThreshold(options = {}) {
  return Math.max(0.1, Number(options.strongSemanticMinScore || config.MEMORY_STRONG_SEMANTIC_MIN_SCORE || 0.82) || 0.82);
}

function isStrongPromptCandidate(item = {}, options = {}) {
  if (!item || typeof item !== 'object') return false;
  if (String(item.evidenceTier || '').trim().toLowerCase() === 'strict') return true;
  const semantic = Number(item.embedding ?? item.semantic ?? item.vectorScore ?? 0) || 0;
  return semantic >= getStrongSemanticThreshold(options);
}

function protectPromptEvidence(results = [], strictResults = [], options = {}) {
  const evidenceSourcesToExclude = new Set(['recent', 'task', 'group', 'style', 'jargon']);
  const byId = new Set((Array.isArray(strictResults) ? strictResults : [])
    .map((item) => normalizeText(item.id))
    .filter(Boolean));
  const protectedResults = (Array.isArray(strictResults) ? strictResults : []).slice();
  const candidates = (Array.isArray(results) ? results : [])
    .filter((item) => !evidenceSourcesToExclude.has(normalizeText(item.source).toLowerCase()))
    .filter((item) => isStrongPromptCandidate(item, options));
  if (!protectedResults.some((item) => !evidenceSourcesToExclude.has(normalizeText(item.source).toLowerCase()))) {
    const best = candidates.find((item) => normalizeText(item.text));
    if (best) {
      const id = normalizeText(best.id);
      const protectedHit = {
        ...best,
        selectionReason: appendSelectionReason(best.selectionReason, 'semantic_prompt_protected'),
        diagnostics: {
          ...(best.diagnostics || {}),
          prompt: {
            ...(best.diagnostics?.prompt || {}),
            protected: true,
            reason: 'semantic_prompt_protected'
          }
        }
      };
      if (!id || !byId.has(id)) protectedResults.unshift(protectedHit);
    }
  }
  return protectedResults;
}

function assembleMemoryPacket(result = {}, options = {}) {
  const userId = normalizeText(result.userId || options.userId);
  const currentSessionKey = normalizeText(options.sessionKey || result.sessionKey);
  const profileProjection = loadProfileProjection();
  const profile = profileProjection.users?.[userId] || {};
  const results = Array.isArray(result.results) ? result.results : [];
  const rawStrictResults = Array.isArray(result.strictResults) ? result.strictResults : results;
  const strictResults = protectPromptEvidence(results, rawStrictResults, options);
  const strictIds = new Set(strictResults.map((item) => normalizeText(item.id)).filter(Boolean));
  const weakResults = (Array.isArray(result.weakResults) ? result.weakResults : [])
    .filter((item) => !strictIds.has(normalizeText(item.id)));
  const continuity = results.filter((item) => item.source === 'recent');
  const prioritizedContinuity = currentSessionKey
    ? continuity.filter((item) => normalizeText(item.sessionKey) === currentSessionKey)
    : [];
  const effectiveContinuity = prioritizedContinuity.length > 0 ? prioritizedContinuity : continuity;
  const evidence = strictResults.filter((item) => item.source !== 'recent' && item.source !== 'task' && item.source !== 'group' && item.source !== 'style' && item.source !== 'jargon').slice(0, 3);
  const weakEvidence = weakResults.filter((item) => item.source !== 'recent').slice(0, 2);
  const task = results.filter((item) => item.source === 'task');
  const group = results.filter((item) => item.source === 'group');
  const style = results.filter((item) => item.source === 'style' || item.source === 'jargon');
  const profileSurface = buildStableProfileText(userId, {
    question: options.question || result.query || '',
    profileProjection,
    forceStableProfile: options.forceStableProfile,
    disableStableProfile: options.disableStableProfile,
    legacyFallbackEnabled: options.legacyProfileFallbackEnabled
  });

  const packet = {
    sessionContinuityText: effectiveContinuity.map((item) => clampText(item.text, 600)).filter(Boolean).join('\n\n'),
    relevantEvidenceText: evidence.map((item) => `[${item.source}|${item.type}] ${clampText(item.text, 220)}`).filter(Boolean).join('\n'),
    weakEvidenceText: weakEvidence.map((item) => `[${item.source}|${item.type}] ${clampText(item.text, 120)}`).filter(Boolean).join('\n'),
    stableProfileText: profileSurface.text,
    stableProfileSource: profileSurface.source,
    stableProfile: profileSurface,
    taskStrategyText: task.map((item) => clampText(item.text, 220)).filter(Boolean).join('\n'),
    groupSharedContextText: group.map((item) => clampText(item.text, 220)).filter(Boolean).join('\n'),
    styleSignalsText: style.map((item) => clampText(item.text.replace(/^style:\s*/i, '').replace(/^group jargon:\s*/i, ''), 160)).filter(Boolean).join('\n'),
    digest: normalizeText(result.digest || '')
  };

  packet.messages = {
    sessionContinuity: toMessage('SessionContinuity', packet.sessionContinuityText, budget('MAIN_PROMPT_CONTINUITY_MAX_CHARS', 220)),
    relevantEvidence: toMessage('RelevantEvidence', packet.relevantEvidenceText, Math.min(budget('MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS', 420), Number(config.MEMORY_V3_RELEVANT_EVIDENCE_MAX_TOKENS || 240))),
    weakEvidence: (strictResults.length < 2)
      ? toMessage('WeakEvidence', packet.weakEvidenceText, Number(config.MEMORY_V3_WEAK_EVIDENCE_MAX_TOKENS || 80))
      : [],
    stableProfile: toMessage('StableProfile', packet.stableProfileText, Math.min(budget('MAIN_PROMPT_LONG_TERM_PROFILE_MAX_TOKENS', 220), Number(config.MEMORY_V3_PERSONA_MAX_TOKENS || 220))),
    taskStrategy: toMessage('TaskStrategy', packet.taskStrategyText, budget('MAIN_PROMPT_TASK_MEMORY_MAX_TOKENS', 160)),
    groupSharedContext: toMessage('GroupSharedContext', packet.groupSharedContextText, budget('MAIN_PROMPT_GROUP_MEMORY_MAX_TOKENS', 160)),
    styleSignals: toMessage('StyleSignals', packet.styleSignalsText, budget('MAIN_PROMPT_STYLE_SIGNALS_MAX_TOKENS', 80))
  };

  return packet;
}

module.exports = {
  assembleMemoryPacket
};

const config = require('../../config');
const { trimTextByTokenBudget } = require('../contextBudget');
const { normalizeText, clampText } = require('./helpers');
const { loadProfileProjection } = require('./storage');

function budget(name, fallback) {
  return Math.max(0, Number(config[name] || fallback) || fallback || 0);
}

function toMessage(label, text, tokenBudget) {
  const value = trimTextByTokenBudget(String(text || '').trim(), tokenBudget, 'tail');
  if (!value) return [];
  return [{ role: 'system', content: `[${label}]\n${value}` }];
}

function assembleMemoryPacket(result = {}, options = {}) {
  const userId = normalizeText(result.userId || options.userId);
  const profileProjection = loadProfileProjection();
  const profile = profileProjection.users?.[userId] || {};
  const results = Array.isArray(result.results) ? result.results : [];
  const strictResults = Array.isArray(result.strictResults) ? result.strictResults : results;
  const weakResults = Array.isArray(result.weakResults) ? result.weakResults : [];
  const persona = result.persona || profile.personaCore || {};
  const continuity = results.filter((item) => item.source === 'recent');
  const evidence = strictResults.filter((item) => item.source !== 'recent' && item.source !== 'task' && item.source !== 'group' && item.source !== 'style' && item.source !== 'jargon').slice(0, 3);
  const weakEvidence = weakResults.filter((item) => item.source !== 'recent').slice(0, 2);
  const task = results.filter((item) => item.source === 'task');
  const group = results.filter((item) => item.source === 'group');
  const style = results.filter((item) => item.source === 'style' || item.source === 'jargon');
  const profileLines = [
    profile.relation_stage ? `关系阶段：${profile.relation_stage}` : '',
    persona.summary ? `总结：${persona.summary}` : '',
    persona.impression ? `印象：${persona.impression}` : '',
    persona.botBasePersona ? `基础人格：${persona.botBasePersona}` : '',
    persona.userAdaptationPersona ? `用户修正：${persona.userAdaptationPersona}` : '',
    persona.relationshipStyle ? `关系风格：${persona.relationshipStyle}` : '',
    persona.replyStyle ? `表达风格：${persona.replyStyle}` : '',
    persona.relationshipTone ? `关系语气：${persona.relationshipTone}` : ''
  ].filter(Boolean).join('\n');

  const packet = {
    sessionContinuityText: continuity.map((item) => clampText(item.text, 600)).filter(Boolean).join('\n\n'),
    relevantEvidenceText: evidence.map((item) => `[${item.source}|${item.type}] ${clampText(item.text, 220)}`).filter(Boolean).join('\n'),
    weakEvidenceText: weakEvidence.map((item) => `[${item.source}|${item.type}] ${clampText(item.text, 120)}`).filter(Boolean).join('\n'),
    stableProfileText: profileLines,
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

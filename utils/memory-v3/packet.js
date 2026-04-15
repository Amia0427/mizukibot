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
  const continuity = results.filter((item) => item.source === 'recent');
  const evidence = results.filter((item) => item.source !== 'recent' && item.source !== 'task' && item.source !== 'group' && item.source !== 'style' && item.source !== 'jargon');
  const task = results.filter((item) => item.source === 'task');
  const group = results.filter((item) => item.source === 'group');
  const style = results.filter((item) => item.source === 'style' || item.source === 'jargon');
  const profileLines = [
    profile.relation_stage ? `关系阶段：${profile.relation_stage}` : '',
    Array.isArray(profile.identities) && profile.identities.length ? `身份：${profile.identities.slice(0, 4).join('、')}` : '',
    Array.isArray(profile.personality_traits) && profile.personality_traits.length ? `性格：${profile.personality_traits.slice(0, 4).join('、')}` : '',
    Array.isArray(profile.likes) && profile.likes.length ? `喜欢：${profile.likes.slice(0, 4).join('、')}` : '',
    Array.isArray(profile.dislikes) && profile.dislikes.length ? `不喜欢：${profile.dislikes.slice(0, 4).join('、')}` : '',
    Array.isArray(profile.goals) && profile.goals.length ? `目标：${profile.goals.slice(0, 4).join('、')}` : '',
    Array.isArray(profile.impressions) && profile.impressions.length ? `印象：${profile.impressions.slice(0, 2).join('；')}` : '',
    Array.isArray(profile.summaries) && profile.summaries.length ? `总结：${profile.summaries.slice(0, 2).join('；')}` : ''
  ].filter(Boolean).join('\n');

  const packet = {
    sessionContinuityText: continuity.map((item) => clampText(item.text, 600)).filter(Boolean).join('\n\n'),
    relevantEvidenceText: evidence.map((item) => `[${item.source}|${item.type}] ${clampText(item.text, 220)}`).filter(Boolean).join('\n'),
    stableProfileText: profileLines,
    taskStrategyText: task.map((item) => clampText(item.text, 220)).filter(Boolean).join('\n'),
    groupSharedContextText: group.map((item) => clampText(item.text, 220)).filter(Boolean).join('\n'),
    styleSignalsText: style.map((item) => clampText(item.text.replace(/^style:\s*/i, '').replace(/^group jargon:\s*/i, ''), 160)).filter(Boolean).join('\n'),
    digest: normalizeText(result.digest || '')
  };

  packet.messages = {
    sessionContinuity: toMessage('SessionContinuity', packet.sessionContinuityText, budget('MAIN_PROMPT_CONTINUITY_MAX_CHARS', 220)),
    relevantEvidence: toMessage('RelevantEvidence', packet.relevantEvidenceText, budget('MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS', 420)),
    stableProfile: toMessage('StableProfile', packet.stableProfileText, budget('MAIN_PROMPT_LONG_TERM_PROFILE_MAX_TOKENS', 220)),
    taskStrategy: toMessage('TaskStrategy', packet.taskStrategyText, budget('MAIN_PROMPT_TASK_MEMORY_MAX_TOKENS', 160)),
    groupSharedContext: toMessage('GroupSharedContext', packet.groupSharedContextText, budget('MAIN_PROMPT_GROUP_MEMORY_MAX_TOKENS', 160)),
    styleSignals: toMessage('StyleSignals', packet.styleSignalsText, budget('MAIN_PROMPT_STYLE_SIGNALS_MAX_TOKENS', 80))
  };

  return packet;
}

module.exports = {
  assembleMemoryPacket
};

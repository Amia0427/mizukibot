const config = require('../../config');
const { estimateTokens, trimTextByTokenBudget } = require('../contextBudget');
const {
  DEFAULT_SURFACE,
  getSurfacePolicy,
  normalizeArray,
  normalizeObject,
  normalizeText
} = require('./helpers');

function clampMessageText(text = '', tokenBudget = 0, fallbackChars = 220) {
  const value = normalizeText(text);
  if (!value) return '';
  if (tokenBudget > 0) return trimTextByTokenBudget(value, tokenBudget, 'tail');
  return normalizeText(value, fallbackChars);
}

function buildPromptBlock(label, text, tokenBudget) {
  const value = clampMessageText(text, tokenBudget, 480);
  if (!value) return null;
  return {
    label,
    text: value,
    message: { role: 'system', content: `[${label}]\n${value}` }
  };
}

function sanitizePromptBlocks(blocks = [], totalBudget = 2400) {
  const selected = normalizeArray(blocks).filter(Boolean);
  const messages = [];
  let used = 0;
  for (const block of selected) {
    const msg = block?.message;
    if (!msg) continue;
    const cost = estimateTokens(String(msg.content || ''));
    if (used > 0 && used + cost > totalBudget && block.label !== 'PersonaCore' && block.label !== 'SurfacePolicy') {
      continue;
    }
    messages.push(msg);
    used += cost;
  }
  return messages;
}

function formatRelationshipStateText(state = {}) {
  const lines = [];
  if (state.relationship) lines.push(`relationship=${state.relationship}`);
  if (state.distanceMode) lines.push(`distance=${state.distanceMode}`);
  if (state.attitude) lines.push(`tone=${normalizeText(state.attitude, 72)}`);
  if (state.replyStylePolicy) lines.push(`reply=${normalizeText(state.replyStylePolicy, 72)}`);
  if (state.salutationStyle || state.salutationPolicy) lines.push(`salutation=${normalizeText(state.salutationStyle || state.salutationPolicy, 48)}`);
  return lines.join('\n');
}

function formatContinuityStateText(state = {}, options = {}) {
  const lines = [];
  if (state.activeTopic) lines.push(`active_topic=${state.activeTopic}`);
  if (state.carryOverUserTurn) lines.push(`carry_over_user_turn=${state.carryOverUserTurn}`);
  if (normalizeArray(state.openLoops).length) lines.push(`open_loops=${state.openLoops.join(' | ')}`);
  if (normalizeArray(state.assistantCommitments).length) lines.push(`assistant_commitments=${state.assistantCommitments.join(' | ')}`);
  if (normalizeArray(state.userConstraints).length) lines.push(`user_constraints=${state.userConstraints.join(' | ')}`);
  if (state.phaseHint) lines.push(`phase_hint=${state.phaseHint}`);
  if (state.replyPosture) lines.push(`reply_posture=${state.replyPosture}`);
  if (normalizeArray(state.activePersonaModules).length) lines.push(`active_persona_modules=${state.activePersonaModules.join(' | ')}`);
  if (normalizeArray(state.styleAnchors).length) lines.push(`style_anchors=${state.styleAnchors.join(' | ')}`);
  if (state.sceneTopic) lines.push(`scene_topic=${state.sceneTopic}`);
  if (state.sceneAtmosphere) lines.push(`scene_atmosphere=${state.sceneAtmosphere}`);
  if (state.recentReplyFrame && options.includeRecentReplyFrame !== false) lines.push(`recent_reply_frame=${state.recentReplyFrame}`);
  if (state.summary) lines.push(`summary=${state.summary}`);
  if (normalizeObject(state.sources) && Object.keys(state.sources).length > 0) {
    const sourceLines = [];
    if (state.sources.activeTopic) sourceLines.push(`active_topic:${state.sources.activeTopic}`);
    if (state.sources.carryOverUserTurn) sourceLines.push(`carry_over:${state.sources.carryOverUserTurn}`);
    if (state.sources.summary) sourceLines.push(`summary:${state.sources.summary}`);
    if (sourceLines.length) lines.push(`sources=${sourceLines.join(', ')}`);
  }
  return lines.join('\n');
}

function formatExpressionStateText(state = {}) {
  const compact = (entry, fallback = '') => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return normalizeText(entry.value || fallback, 24);
    }
    return normalizeText(entry || fallback, 24);
  };
  return [
    `reply_posture=${compact(state.replyPosture, 'light')}`,
    `warmth=${compact(state.warmth, 'mid')}`,
    `play=${compact(state.playfulness, 'low')}`,
    `tease=${compact(state.tease, 'off')}`,
    `initiative=${compact(state.initiative, 'reply')}`,
    `jargon=${compact(state.jargon, 'off')}`,
    `verbosity=${compact(state.verbosity, 'normal')}`,
    `guarded=${compact(state.guardedness, 'guarded')}`
  ].join('\n');
}

function formatMemoryDigestText(digest = {}) {
  return normalizeArray(digest.items)
    .map((item) => `[${item.source}${item.label ? `|${item.label}` : ''}] ${item.text}`)
    .join('\n');
}

function formatSurfacePolicyText(surface = '', policy = {}) {
  return [
    `surface=${surface || DEFAULT_SURFACE}`,
    `include_continuity=${policy.includeContinuity !== false}`,
    `include_relationship=${policy.includeRelationship !== false}`,
    `include_recent_reply_frame=${policy.includeRecentReplyFrame !== false}`,
    `include_deep_history=${policy.includeDeepHistory !== false}`,
    `allow_jargon=${policy.allowJargon || 'off'}`,
    `max_memory_digest_items=${Number(policy.maxMemoryDigestItems || 0) || 0}`,
    policy.privacyMode ? `privacy_mode=${policy.privacyMode}` : '',
    policy.chatDiscipline ? `chat_discipline=${policy.chatDiscipline}` : '',
    policy.replyRhythm ? `reply_rhythm=${policy.replyRhythm}` : ''
  ].filter(Boolean).join('\n');
}

function renderPersonaMemoryPrompt(state = {}, surface = '') {
  const normalizedState = normalizeObject(state);
  const surfaceName = normalizeText(surface || normalizedState.surface || DEFAULT_SURFACE).toLowerCase() || DEFAULT_SURFACE;
  const surfacePolicy = getSurfacePolicy(surfaceName);
  const promptBudget = Math.max(1000, Number(config.MAIN_PROMPT_PERSONA_MEMORY_MAX_TOKENS || 2200) || 2200);
  const promptBlocks = [
    buildPromptBlock('PersonaCore', normalizedState.personaCore?.text, Math.min(promptBudget * 0.3, 900)),
    surfacePolicy.includeRelationship !== false
      ? buildPromptBlock('RelationshipState', formatRelationshipStateText(normalizedState.relationshipState), 220)
      : null,
    surfacePolicy.includeContinuity !== false
      ? buildPromptBlock('ContinuityState', formatContinuityStateText(normalizedState.continuityState, {
          includeRecentReplyFrame: surfacePolicy.includeRecentReplyFrame !== false
        }), 360)
      : null,
    buildPromptBlock('ExpressionPolicy', formatExpressionStateText(normalizedState.expressionState), 140),
    buildPromptBlock('RelevantMemoryDigest', formatMemoryDigestText(normalizedState.memoryDigest), 360),
    buildPromptBlock('SurfacePolicy', formatSurfacePolicyText(surfaceName, surfacePolicy), 140)
  ].filter(Boolean);

  return {
    systemMessages: sanitizePromptBlocks(promptBlocks, promptBudget),
    promptBlocks,
    policy: surfacePolicy
  };
}

module.exports = {
  buildPromptBlock,
  clampMessageText,
  formatContinuityStateText,
  formatExpressionStateText,
  formatMemoryDigestText,
  formatRelationshipStateText,
  formatSurfacePolicyText,
  renderPersonaMemoryPrompt,
  sanitizePromptBlocks
};

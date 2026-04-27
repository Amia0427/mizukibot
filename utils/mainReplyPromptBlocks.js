function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

const MAIN_REPLY_DYNAMIC_BLOCKS = Object.freeze([
  {
    blockId: 'affinity_level',
    label: 'Affinity Level',
    lane: 'dynamic_context',
    category: 'memory_state',
    defaultPolicy: 'usually_on',
    useWhen: 'When relationship distance should subtly shape tone.',
    avoidWhen: 'Do not rely on it for safety, refusal, or tool policy.'
  },
  {
    blockId: 'affinity_points',
    label: 'Affinity Points',
    lane: 'dynamic_context',
    category: 'memory_state',
    defaultPolicy: 'usually_on',
    useWhen: 'When the reply should preserve stable relational continuity.',
    avoidWhen: 'Do not treat it as a visible score or something to mention explicitly.'
  },
  {
    blockId: 'persona_memory',
    label: 'Persona Memory',
    lane: 'dynamic_context',
    category: 'persona_memory',
    defaultPolicy: 'situational',
    useWhen: 'Use when the current turn benefits from durable persona memory or phase continuity.',
    avoidWhen: 'Skip when the turn is purely transactional and persona memory adds no value.'
  },
  {
    blockId: 'long_term_profile',
    label: 'Long Term Profile',
    lane: 'dynamic_context',
    category: 'memory_profile',
    defaultPolicy: 'situational',
    useWhen: 'Use when preferences, identity, long-term habits, or persistent facts matter.',
    avoidWhen: 'Skip when the turn is self-contained and profile facts are not needed.'
  },
  {
    blockId: 'impression',
    label: 'Impression',
    lane: 'dynamic_context',
    category: 'memory_profile',
    defaultPolicy: 'situational',
    useWhen: 'Use when subtle interpersonal tone should reflect prior impression.',
    avoidWhen: 'Skip if it would only add vague mood coloring without helping the reply.'
  },
  {
    blockId: 'relationship_state',
    label: 'Relationship State',
    lane: 'dynamic_context',
    category: 'memory_profile',
    defaultPolicy: 'situational',
    useWhen: 'Use when social distance, intimacy, or tone calibration matters.',
    avoidWhen: 'Do not use it to override safety or fabricate intimacy.'
  },
  {
    blockId: 'summary',
    label: 'Summary',
    lane: 'dynamic_context',
    category: 'memory_summary',
    defaultPolicy: 'situational',
    useWhen: 'Use when a compact carry-over summary materially improves continuity.',
    avoidWhen: 'Skip when the turn is fresh and self-contained.'
  },
  {
    blockId: 'retrieved_memory_lite',
    label: 'Retrieved Memory Lite',
    lane: 'dynamic_context',
    category: 'memory_summary',
    defaultPolicy: 'high_value_only',
    useWhen: 'Use when the turn depends on specific recalled facts, prior preferences, or continuity anchors.',
    avoidWhen: 'Skip for generic small talk or when it would add noisy turn-local detail.'
  },
  {
    blockId: 'daily_journal',
    label: 'Daily Journal',
    lane: 'dynamic_context',
    category: 'memory_summary',
    defaultPolicy: 'high_value_only',
    useWhen: 'Use when the user asks about yesterday, a specific date, recent days, or what happened in prior conversation.',
    avoidWhen: 'Skip when the turn is self-contained and day-level recall is not useful.'
  },
  {
    blockId: 'continuity_state',
    label: 'Continuity State',
    lane: 'dynamic_context',
    category: 'continuity',
    defaultPolicy: 'situational',
    useWhen: 'Must use when there is a carry-over topic, open loop, unresolved promise, or obvious continuation.',
    avoidWhen: 'Skip when the turn clearly starts a new topic and no carry-over matters.'
  },
  {
    blockId: 'directed_context',
    label: 'Directed Context',
    lane: 'dynamic_context',
    category: 'conversation_routing',
    defaultPolicy: 'must_use_when_available',
    useWhen: 'Must use for quoted replies, group reply targeting, ellipsis resolution, or addressee disambiguation.',
    avoidWhen: 'Skip only when no directed context exists.'
  },
  {
    blockId: 'style_profile',
    label: 'Style Profile',
    lane: 'dynamic_context',
    category: 'style',
    defaultPolicy: 'situational',
    useWhen: 'Use when group or scene-specific style adaptation helps the reply feel locally native.',
    avoidWhen: 'Skip when stable persona style is enough and extra style pressure is unnecessary.'
  },
  {
    blockId: 'social_context',
    label: 'Social Context',
    lane: 'dynamic_context',
    category: 'social',
    defaultPolicy: 'situational',
    useWhen: 'Use in group chats or socially dense scenes where relationship map and norms matter.',
    avoidWhen: 'Skip in private chat or when there is no meaningful group context.'
  },
  {
    blockId: 'self_improvement',
    label: 'Self Improvement',
    lane: 'dynamic_context',
    category: 'optimization',
    defaultPolicy: 'situational',
    useWhen: 'Use when there is a clear learned pattern that improves this kind of reply.',
    avoidWhen: 'Skip if it is generic, stale, noisy, or would over-steer style.'
  },
  {
    blockId: 'dynamic_few_shot',
    label: 'Dynamic Few Shot',
    lane: 'assistant_only',
    category: 'few_shot',
    defaultPolicy: 'high_value_only',
    useWhen: 'Use when exemplar steering is likely to noticeably improve difficult style or structure matching.',
    avoidWhen: 'Skip for ordinary turns, repetitive scenes, or when examples would mostly waste context.'
  },
  {
    blockId: 'memory_cli_instruction',
    label: 'Memory CLI Instruction',
    lane: 'dynamic_context',
    category: 'tool_policy',
    defaultPolicy: 'situational',
    useWhen: 'Use only when memory_cli is actually exposed for the current turn.',
    avoidWhen: 'Skip when tools are disabled or memory_cli is unavailable.'
  },
  {
    blockId: 'context_stats_instruction',
    label: 'Context Stats Instruction',
    lane: 'dynamic_context',
    category: 'tool_policy',
    defaultPolicy: 'situational',
    useWhen: 'Use when get_context_stats is exposed and the assistant may need to answer context-budget questions.',
    avoidWhen: 'Skip when tools are disabled or the route cannot expose context stats.'
  },
  {
    blockId: 'life_scheduler',
    label: 'Life Scheduler',
    lane: 'dynamic_context',
    category: 'scheduler',
    defaultPolicy: 'situational',
    useWhen: 'Use only when the scheduler runtime provides a fresh injection block for the current turn.',
    avoidWhen: 'Skip when no scheduler injection exists.'
  }
]);

function getMainReplyDynamicBlockCatalog(personaModuleCatalog = []) {
  const baseBlocks = MAIN_REPLY_DYNAMIC_BLOCKS.map((item) => ({ ...item }));
  const personaBlocks = normalizeArray(personaModuleCatalog)
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      blockId: `persona_module:${normalizeText(item.moduleId)}`,
      label: normalizeText(item.moduleId),
      lane: 'dynamic_context',
      category: 'persona_module',
      defaultPolicy: 'planner_selected',
      phase: normalizeText(item.phase, 'all'),
      slot: normalizeText(item.slot, 'general'),
      purpose: normalizeText(item.purpose),
      conflictsWith: normalizeArray(item.conflictsWith).map((entry) => normalizeText(entry)).filter(Boolean),
      triggerHints: normalizeArray(item.triggerHints).map((entry) => normalizeText(entry)).filter(Boolean),
      useWhen: `Use when the turn clearly matches this module's purpose: ${normalizeText(item.purpose) || 'specialized persona modulation'}.`,
      avoidWhen: 'Skip when another module already fills the same slot, conflicts with it, or the scene does not genuinely call for it.'
    }))
    .filter((item) => item.label);
  return baseBlocks.concat(personaBlocks);
}

function buildHeuristicDynamicPromptPlan(input = {}) {
  const enabledBlockIds = [];
  const rationaleByBlock = {};
  const push = (blockId, reason) => {
    const normalizedId = normalizeText(blockId);
    if (!normalizedId || enabledBlockIds.includes(normalizedId)) return;
    enabledBlockIds.push(normalizedId);
    if (normalizeText(reason)) rationaleByBlock[normalizedId] = normalizeText(reason);
  };
  const continuitySignals = input?.continuitySignals && typeof input.continuitySignals === 'object'
    ? input.continuitySignals
    : {};
  const directedContext = input?.directedContext && typeof input.directedContext === 'object'
    ? input.directedContext
    : null;

  if (directedContext && (normalizeText(directedContext.scene) || normalizeText(directedContext?.addressee?.senderName) || normalizeText(directedContext?.quote?.text))) {
    push('directed_context', 'directed or quoted conversation context is available');
  }
  if (continuitySignals.hasCarryOverTopic || continuitySignals.hasOpenLoop || continuitySignals.quoteAnchored) {
    push('continuity_state', 'carry-over topic or open loop detected');
    push('summary', 'continuity benefits from a compact carry-over summary');
    push('retrieved_memory_lite', 'continuity may need recalled memory anchors');
  }
  if (input.hasRetrievedMemory) {
    push('retrieved_memory_lite', 'retrieved memory candidates are available for this turn');
  }
  if (input.hasDailyJournal) {
    push('daily_journal', 'daily journal recall is available for this turn');
  }
  if (input.hasLongTermProfile) push('long_term_profile', 'long-term profile is available and may help continuity');
  if (input.hasImpression) push('impression', 'prior impression can shape reply tone');
  if (input.hasRelationshipState) push('relationship_state', 'relationship state helps social distance calibration');
  if (input.hasStyleProfile) push('style_profile', 'style profile is available for local adaptation');
  if (input.hasSocialContext) push('social_context', 'social context is available for this scene');
  if (input.hasSelfImprovement) push('self_improvement', 'learned self-improvement snippet is available');
  if (input.hasDynamicFewShot) push('dynamic_few_shot', 'few-shot examples are available for this turn');
  if (input.hasMemoryCliInstruction) push('memory_cli_instruction', 'memory_cli is exposed this turn');
  if (input.hasContextStatsInstruction) push('context_stats_instruction', 'context stats tool is exposed this turn');
  if (input.hasLifeScheduler) push('life_scheduler', 'life scheduler provided a live injection');
  if (input.hasAffinityState) {
    push('affinity_level', 'affinity state is available');
    push('affinity_points', 'affinity state is available');
  }

  return {
    enabledBlockIds,
    personaModules: normalizeArray(input.personaModules).map((item) => normalizeText(item)).filter(Boolean).slice(0, 2),
    rationaleByBlock
  };
}

function buildMainReplyDynamicPromptGuide(personaModuleCatalog = []) {
  const personaLines = normalizeArray(personaModuleCatalog)
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const moduleId = normalizeText(item.moduleId);
      if (!moduleId) return '';
      const triggers = normalizeArray(item.triggerHints).map((entry) => normalizeText(entry)).filter(Boolean).slice(0, 4).join('; ');
      const conflicts = normalizeArray(item.conflictsWith).map((entry) => normalizeText(entry)).filter(Boolean).join(', ');
      const phase = normalizeText(item.phase, 'all');
      const slot = normalizeText(item.slot, 'general');
      return [
        `- ${moduleId}`,
        `  use: ${normalizeText(item.purpose) || 'specialized persona modulation'}`,
        `  phase: ${phase}`,
        `  slot: ${slot}`,
        `  triggers: ${triggers || 'match the scene semantically, not literally'}`,
        `  conflicts: ${conflicts || 'none declared'}`,
        '  avoid: do not activate it just because a single keyword matched; require scene fit and tone fit.'
      ].join('\n');
    })
    .filter(Boolean)
    .join('\n');

  return [
    'Planner objective: choose the most valuable dynamic prompt blocks for the main reply.',
    'Planner does not need to save its own prompt tokens. Spend planner tokens freely if that helps you choose better main-reply blocks.',
    'Your job is not to manage cache implementation details. Runtime owns cache lanes. Your job is to decide which dynamic blocks are worth adding to the main reply.',
    'Selection rules:',
    '1. Stable persona core, security contract, and core baseline patch are always handled by runtime. Never try to disable them.',
    '2. Use `enabledBlockIds` only for non-persona dynamic blocks. Use `personaModules` only for persona modules.',
    '3. Prefer a smaller high-value set over enabling everything by habit.',
    '4. When a block is clearly required for understanding the turn, include it even if the turn is short.',
    '5. When a block would only add vague flavor, stale memory, or noisy steering, leave it out.',
    'Block guidance:',
    '- `directed_context`: must enable when quoted reply resolution, addressee disambiguation, or group targeting is needed. Do not skip it if the current turn is elliptical or deictic.',
    '- `continuity_state`: must enable when there is a carry-over topic, unresolved thread, prior promise, or open loop that should affect the reply. Skip when the user clearly starts a new topic.',
    '- `style_profile`: enable when local group/style adaptation matters. Skip when the stable persona already provides enough style.',
    '- `social_context`: enable in socially dense group scenes where who-is-who matters. Usually skip in private chat.',
    '- `self_improvement`: enable only when the learned snippet is likely to improve this exact reply pattern. Disable if it looks generic, stale, or likely to overfit.',
    '- `dynamic_few_shot`: enable only for hard style matching, nuanced scene control, or when examples clearly outperform rules. Disable for normal chat or when examples would mostly waste context.',
    '- `retrieved_memory_lite`: enable when specific recalled facts help answer the current turn. Disable when the turn is self-contained or the retrieved facts are weak/noisy.',
    '- `daily_journal`: enable when the user asks about yesterday, a specific date, recent days, or what happened in prior conversation.',
    '- `long_term_profile`, `impression`, `relationship_state`, `summary`: enable the ones that materially help continuity or tone. Do not include all of them mechanically if the scene does not need them.',
    '- `memory_cli_instruction` and `context_stats_instruction`: enable only if those tools are actually exposed this turn.',
    '- `life_scheduler`: enable only if the current runtime really provided a fresh scheduler injection.',
    'Persona module guidance:',
    '- You may activate at most 2 persona modules.',
    '- Respect module conflicts and slot collisions.',
    '- Match module choice to scene phase and emotional phase, not only surface keywords.',
    '- Prefer scene modules plus one emotional/person module when both are needed.',
    '- Avoid piling multiple modules that all push the same tone.',
    personaLines ? 'Available persona modules:\n' + personaLines : 'Available persona modules: none'
  ].filter(Boolean).join('\n');
}

module.exports = {
  MAIN_REPLY_DYNAMIC_BLOCKS,
  buildMainReplyDynamicPromptGuide,
  buildHeuristicDynamicPromptPlan,
  getMainReplyDynamicBlockCatalog
};

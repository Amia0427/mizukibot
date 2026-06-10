function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

const MAIN_REPLY_DYNAMIC_BLOCKS = Object.freeze([
  {
    blockId: 'roleplay_runtime_context',
    label: 'Roleplay Runtime Context',
    lane: 'dynamic_context',
    category: 'roleplay_context',
    defaultPolicy: 'must_use_when_available',
    useWhen: 'Always use for main roleplay replies so Mizuki can anchor the current time, scene, chat mode, visible user state, and output rhythm.',
    avoidWhen: 'Skip only outside main roleplay replies or when no current-turn runtime context exists.'
  },
  {
    blockId: 'chat_liveness_discipline',
    label: 'Chat Liveness Discipline',
    lane: 'dynamic_context',
    category: 'roleplay_context',
    defaultPolicy: 'must_use_when_available',
    useWhen: 'Always use for main private and group chat replies so Mizuki preserves live chat rhythm, limited knowledge, privacy boundaries, and single-chat/group-chat discipline.',
    avoidWhen: 'Skip only outside chat roleplay replies or when no current-turn chat surface exists.'
  },
  {
    blockId: 'roleplay_inner_protocol',
    label: 'Roleplay Inner Protocol',
    lane: 'dynamic_context',
    category: 'roleplay_context',
    defaultPolicy: 'must_use_when_available',
    useWhen: 'Always use for main roleplay replies as a silent pre-reply check for surface, Mizuki motive, relationship distance, live-chat rhythm, and anti-leak final compression.',
    avoidWhen: 'Skip only outside main roleplay replies.'
  },
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
    blockId: 'memory_recall_policy',
    label: 'Memory Recall Policy',
    lane: 'dynamic_context',
    category: 'memory_policy',
    defaultPolicy: 'must_use_when_available',
    useWhen: 'Use when recalled memory evidence is present so memory is interpreted with category, source, lifecycle, and certainty rules.',
    avoidWhen: 'Skip only when no memory evidence or memory tool policy is available.'
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
    blockId: 'memos_recall',
    label: 'MemOS Recall',
    lane: 'dynamic_context',
    category: 'memory_summary',
    defaultPolicy: 'high_value_only',
    useWhen: 'Use when planner-side MemOS recall contains specific external memory evidence that helps this turn.',
    avoidWhen: 'Skip when MemOS recall is empty, generic, stale, or weaker than short-term continuity.'
  },
  {
    blockId: 'openviking_recall',
    label: 'OpenViking Recall',
    lane: 'dynamic_context',
    category: 'memory_summary',
    defaultPolicy: 'high_value_only',
    useWhen: 'Use when OpenViking external long-term recall adds specific evidence not already covered by local Memory V3.',
    avoidWhen: 'Skip when it is empty, duplicated by local memory, conflicts with local memory, or is weaker than short-term continuity.'
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
    blockId: 'short_term_continuity',
    label: 'Short Term Continuity',
    lane: 'dynamic_context',
    category: 'continuity',
    defaultPolicy: 'usually_on',
    useWhen: 'Use whenever recent raw turns, restart summaries, or short-term state are available.',
    avoidWhen: 'Skip only when there is no short-term context or a custom prompt route explicitly suppresses runtime memory.'
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

const DYNAMIC_CONTEXT_BLOCK_SPEC_OVERRIDES = Object.freeze({
  roleplay_runtime_context: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    mustUseWhen: 'main roleplay reply has current-turn runtime context',
    budget: { configKey: '', hardCapTokens: 520 }
  },
  chat_liveness_discipline: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    mustUseWhen: 'main roleplay reply has current-turn private/group chat surface',
    budget: { configKey: '', hardCapTokens: 360 }
  },
  roleplay_inner_protocol: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    mustUseWhen: 'main roleplay reply needs silent pre-reply roleplay quality checks',
    budget: { configKey: '', hardCapTokens: 420 }
  },
  affinity_level: {
    criticality: 'optional',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: '', hardCapTokens: 32 }
  },
  affinity_points: {
    criticality: 'optional',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: '', hardCapTokens: 32 }
  },
  persona_memory: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'MEMORY_V3_PERSONA_MAX_TOKENS', hardCapTokens: 220 }
  },
  long_term_profile: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'MAIN_PROMPT_LONG_TERM_PROFILE_MAX_TOKENS', hardCapTokens: 220 }
  },
  impression: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'MAIN_PROMPT_IMPRESSION_MAX_TOKENS', hardCapTokens: 96 }
  },
  relationship_state: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'MEMORY_V3_RELATIONSHIP_MAX_TOKENS', hardCapTokens: 80 }
  },
  summary: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'MAIN_PROMPT_SUMMARY_MAX_TOKENS', hardCapTokens: 180 }
  },
  retrieved_memory_lite: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS', hardCapTokens: 420 }
  },
  memory_recall_policy: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    mustUseWhen: 'retrieved memory, daily journal, or memory_cli evidence is present',
    budget: { configKey: '', hardCapTokens: 120 }
  },
  memos_recall: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'MEMOS_RECALL_MAX_CHARS', hardCapTokens: 260 }
  },
  openviking_recall: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'OPENVIKING_RECALL_MAX_CHARS', hardCapTokens: 260 }
  },
  daily_journal: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS', hardCapTokens: 160 }
  },
  short_term_continuity: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS', hardCapTokens: 5200 }
  },
  continuity_state: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    mustUseWhen: 'carry-over topic, open loop, prior promise, or quote anchoring exists',
    budget: { configKey: 'MAIN_PROMPT_CONTINUITY_MAX_CHARS', hardCapTokens: 220 }
  },
  directed_context: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    mustUseWhen: 'quoted reply resolution, addressee disambiguation, or group targeting exists',
    budget: { configKey: '', hardCapTokens: 240 }
  },
  style_profile: {
    criticality: 'optional',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'STYLE_PROFILE_PROMPT_MAX_CHARS', hardCapTokens: 80 }
  },
  social_context: {
    criticality: 'optional',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'SOCIAL_CONTEXT_PROMPT_MAX_CHARS', hardCapTokens: 96 }
  },
  self_improvement: {
    criticality: 'optional',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'SELF_IMPROVEMENT_PROMPT_MAX_CHARS', hardCapTokens: 260 }
  },
  dynamic_few_shot: {
    criticality: 'optional',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: '', hardCapTokens: 220 }
  },
  memory_cli_instruction: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    mustUseWhen: 'memory_cli is exposed for the current turn',
    budget: { configKey: '', hardCapTokens: 180 }
  },
  memory_cli_followup: {
    lane: 'dynamic_context',
    category: 'tool_policy',
    defaultPolicy: 'situational',
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    mustUseWhen: 'memory_cli follow-up state is active for the current turn',
    budget: { configKey: '', hardCapTokens: 180 }
  },
  context_stats_instruction: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    mustUseWhen: 'get_context_stats is exposed and the turn can ask about context usage',
    budget: { configKey: '', hardCapTokens: 80 }
  },
  life_scheduler: {
    criticality: 'optional',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: '', hardCapTokens: 180 }
  },
  group_direct_chat_style_guard: {
    lane: 'dynamic_context',
    category: 'style_policy',
    defaultPolicy: 'must_use_when_available',
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    mustUseWhen: 'current turn is a direct reply inside a group chat',
    budget: { configKey: '', hardCapTokens: 180 }
  }
});

function getDynamicContextBlockSpec(blockOrId = '') {
  const rawId = typeof blockOrId === 'object'
    ? normalizeText(blockOrId?.meta?.blockId || (blockOrId?.meta?.moduleId ? `persona_module:${blockOrId.meta.moduleId}` : blockOrId?.id))
    : normalizeText(blockOrId);
  const blockId = rawId.startsWith('persona_module_')
    ? `persona_module:${rawId.slice('persona_module_'.length)}`
    : rawId;
  const base = MAIN_REPLY_DYNAMIC_BLOCKS.find((item) => normalizeText(item.blockId) === blockId) || {};
  const override = DYNAMIC_CONTEXT_BLOCK_SPEC_OVERRIDES[blockId] || {};
  if (blockId.startsWith('persona_module:')) {
    return {
      blockId,
      label: normalizeText(base.label || blockId.slice('persona_module:'.length)),
      lane: normalizeText(base.lane || override.lane, 'dynamic_context'),
      category: normalizeText(base.category || override.category, 'persona_module'),
      defaultPolicy: normalizeText(base.defaultPolicy || override.defaultPolicy, 'planner_selected'),
      useWhen: normalizeText(base.useWhen || override.useWhen),
      avoidWhen: normalizeText(base.avoidWhen || override.avoidWhen),
      mustUseWhen: normalizeText(override.mustUseWhen),
      emptyPolicy: normalizeText(override.emptyPolicy, 'reject_optional_empty'),
      budget: override.budget && typeof override.budget === 'object' ? { ...override.budget } : { configKey: '', hardCapTokens: 120 },
      criticality: normalizeText(override.criticality, 'optional')
    };
  }
  return {
    blockId,
    label: normalizeText(base.label || override.label || blockId),
    lane: normalizeText(base.lane || override.lane, 'dynamic_context'),
    category: normalizeText(base.category || override.category, 'runtime'),
    defaultPolicy: normalizeText(base.defaultPolicy || override.defaultPolicy, 'situational'),
    useWhen: normalizeText(base.useWhen || override.useWhen),
    avoidWhen: normalizeText(base.avoidWhen || override.avoidWhen),
    mustUseWhen: normalizeText(override.mustUseWhen),
    emptyPolicy: normalizeText(override.emptyPolicy, 'allow'),
    budget: override.budget && typeof override.budget === 'object' ? { ...override.budget } : { configKey: '', hardCapTokens: 0 },
    criticality: normalizeText(override.criticality, 'optional')
  };
}

function withDynamicContextBlockSpec(block = {}) {
  const spec = getDynamicContextBlockSpec(block.blockId || block.id);
  return {
    ...block,
    mustUseWhen: normalizeText(block.mustUseWhen || spec.mustUseWhen),
    emptyPolicy: normalizeText(block.emptyPolicy || spec.emptyPolicy),
    budget: block.budget && typeof block.budget === 'object' ? { ...block.budget } : spec.budget,
    criticality: normalizeText(block.criticality || spec.criticality)
  };
}

function getMainReplyDynamicBlockCatalog(personaModuleCatalog = []) {
  const baseBlocks = MAIN_REPLY_DYNAMIC_BLOCKS.map((item) => withDynamicContextBlockSpec({ ...item }));
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
    .map(withDynamicContextBlockSpec)
    .filter((item) => item.label);
  return baseBlocks.concat(personaBlocks);
}

module.exports = {
  DYNAMIC_CONTEXT_BLOCK_SPEC_OVERRIDES,
  MAIN_REPLY_DYNAMIC_BLOCKS,
  getDynamicContextBlockSpec,
  getMainReplyDynamicBlockCatalog,
  normalizeArray,
  normalizeText,
  withDynamicContextBlockSpec
};

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function estimatePromptTokens(value) {
  const text = normalizeText(value);
  if (!text) return 0;
  let cjkChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3400 && code <= 0x9fff) cjkChars += 1;
  }
  const latinChars = text.length - cjkChars;
  return cjkChars + Math.ceil(Math.max(0, latinChars) / 4);
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
  daily_journal: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS', hardCapTokens: 160 }
  },
  short_term_continuity: {
    criticality: 'critical',
    emptyPolicy: 'reject_optional_empty',
    budget: { configKey: 'MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS', hardCapTokens: 2200 }
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

function getPromptBlockPlanIds(block = {}) {
  const blockId = normalizeText(block?.id);
  const aliasId = normalizeText(block?.meta?.blockId);
  const moduleId = normalizeText(block?.meta?.moduleId);
  return {
    blockId,
    aliasId,
    moduleId,
    primaryId: aliasId || (moduleId ? `persona_module:${moduleId}` : blockId),
    ids: [blockId, aliasId].filter(Boolean)
  };
}

function blockHasUsableDynamicContextContent(block = {}) {
  const content = normalizeText(block?.content);
  if (!content) return false;
  const { blockId, aliasId } = getPromptBlockPlanIds(block);
  const key = aliasId || blockId;
  const emptyPatternByBlock = {
    retrieved_memory_lite: /\[RetrievedMemoryLite\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    retrieved_memory_compact: /\[RetrievedMemoryLite\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    daily_journal: /\[DailyJournal\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    daily_journal_compact: /\[DailyJournal\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    long_term_profile: /\[LongTermProfile\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    long_term_profile_compact: /\[LongTermProfile\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    impression: /\[Impression\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    impression_compact: /\[Impression\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    summary: /\[Summary\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    summary_compact: /\[Summary\]\s*(?:none|null|undefined|暂无|无)?\s*$/i
  };
  const pattern = emptyPatternByBlock[key];
  if (pattern && pattern.test(content)) return false;
  const spec = getDynamicContextBlockSpec(aliasId || (block?.meta?.moduleId ? `persona_module:${block.meta.moduleId}` : blockId));
  if (spec.emptyPolicy === 'reject_optional_empty' && /^(none|null|undefined|暂无|无)$/i.test(content)) return false;
  return true;
}

function pushUniqueEntry(list = [], entry = {}) {
  const id = normalizeText(entry.id || entry.blockId || (entry.moduleId ? `persona_module:${entry.moduleId}` : ''));
  const reason = normalizeText(entry.reason);
  if (!id) return;
  if (list.some((item) => normalizeText(item.id || item.blockId || (item.moduleId ? `persona_module:${item.moduleId}` : '')) === id && normalizeText(item.reason) === reason)) return;
  list.push({ id, ...entry });
}

function buildContextBudgetReport(selectionTrace = [], options = {}) {
  const budgetTokens = Math.max(0, Number(options.budgetTokens || 0) || 0);
  const selectedRows = normalizeArray(selectionTrace).filter((item) => item.selected === true);
  const usedByLane = {};
  for (const row of selectedRows) {
    const lane = normalizeText(row.lane, 'dynamic_context');
    usedByLane[lane] = (usedByLane[lane] || 0) + Math.max(0, Number(row.estimatedTokens || 0) || 0);
  }
  const usedTokens = selectedRows.reduce((sum, row) => sum + Math.max(0, Number(row.estimatedTokens || 0) || 0), 0);
  return {
    schemaVersion: 'context_budget_report_v1',
    budgetTokens,
    usedTokens,
    remainingTokens: budgetTokens > 0 ? Math.max(0, budgetTokens - usedTokens) : 0,
    usedByLane,
    selectedBlockCount: selectedRows.length,
    skippedBlockCount: Math.max(0, normalizeArray(selectionTrace).length - selectedRows.length),
    blocks: normalizeArray(selectionTrace).map((row) => ({
      id: row.id,
      lane: row.lane,
      category: row.category,
      criticality: row.criticality,
      selected: row.selected === true,
      decision: row.decision,
      reason: row.reason,
      estimatedTokens: row.estimatedTokens,
      budgetTokens: row.budgetTokens,
      budgetConfigKey: row.budgetConfigKey,
      overBlockBudget: row.overBlockBudget === true
    }))
  };
}

function selectDynamicContextBlocks(input = {}) {
  const blocks = normalizeArray(input.blocks);
  const dynamicPromptPlan = input.dynamicPromptPlan && typeof input.dynamicPromptPlan === 'object' ? input.dynamicPromptPlan : {};
  const requiredIds = new Set(normalizeArray(input.requiredIds).map((item) => normalizeText(item)).filter(Boolean));
  const runtimeAddedIds = new Set(normalizeArray(input.runtimeAddedIds).map((item) => normalizeText(item)).filter(Boolean));
  const enabledIds = new Set(normalizeArray(dynamicPromptPlan.enabledBlockIds).map((item) => normalizeText(item)).filter(Boolean));
  const enabledPersonaModules = new Set(normalizeArray(dynamicPromptPlan.personaModules).map((item) => normalizeText(item)).filter(Boolean));
  const skippedIds = new Set();
  const skippedPersonaModules = new Set();
  const runtimeAddedBlocks = [];
  const runtimeRejectedBlocks = [];

  for (const decision of normalizeArray(dynamicPromptPlan.blockDecisions)) {
    if (normalizeText(decision?.decision).toLowerCase() !== 'skip') continue;
    if (normalizeText(decision.blockId)) skippedIds.add(normalizeText(decision.blockId));
    if (normalizeText(decision.moduleId)) skippedPersonaModules.add(normalizeText(decision.moduleId));
  }

  const selectedBlocks = [];
  const selectionTrace = [];
  const availablePlanIds = new Set();
  const selectedPlanIds = new Set();
  const rejectedPlanIds = new Set();

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const { blockId, aliasId, moduleId, ids, primaryId } = getPromptBlockPlanIds(block);
    if (!blockId) continue;
    ids.forEach((id) => availablePlanIds.add(id));
    if (moduleId) availablePlanIds.add(`persona_module:${moduleId}`);

    const planId = primaryId || blockId;
    const spec = getDynamicContextBlockSpec(planId);
    const optional = block?.meta?.optional === true;
    const required = ids.some((id) => requiredIds.has(id)) || Boolean(moduleId && requiredIds.has(`persona_module:${moduleId}`));
    const runtimeAdded = ids.some((id) => runtimeAddedIds.has(id)) || Boolean(moduleId && runtimeAddedIds.has(`persona_module:${moduleId}`));
    const includedByPlanner = ids.some((id) => enabledIds.has(id)) || Boolean(moduleId && enabledPersonaModules.has(moduleId));
    const skippedByPlanner = ids.some((id) => skippedIds.has(id)) || Boolean(moduleId && skippedPersonaModules.has(moduleId));
    const includeBlock = !optional
      || required
      || runtimeAdded
      || (includedByPlanner && !skippedByPlanner);
    const estimatedTokens = estimatePromptTokens(block.content);
    const budgetTokens = Math.max(0, Number(block.budgetTokens || spec.budget?.hardCapTokens || 0) || 0);
    const baseTrace = {
      id: planId,
      blockId: moduleId ? undefined : (aliasId || blockId),
      moduleId: moduleId || undefined,
      lane: normalizeText(block.lane || block.cacheLane || spec.lane, 'dynamic_context'),
      category: normalizeText(spec.category, 'runtime'),
      criticality: normalizeText(spec.criticality, 'optional'),
      optional,
      required,
      runtimeAdded,
      includedByPlanner,
      skippedByPlanner,
      estimatedTokens,
      budgetTokens,
      budgetConfigKey: normalizeText(spec.budget?.configKey),
      overBlockBudget: budgetTokens > 0 && estimatedTokens > budgetTokens
    };

    if (!includeBlock) {
      selectionTrace.push({
        ...baseTrace,
        selected: false,
        decision: 'skip',
        reason: skippedByPlanner ? 'planner_skip' : 'not_selected'
      });
      continue;
    }

    const usable = blockHasUsableDynamicContextContent(block);
    if (!usable && optional) {
      const rejectedId = planId;
      rejectedPlanIds.add(rejectedId);
      const reason = 'no_real_content';
      if (includedByPlanner || runtimeAdded) {
        pushUniqueEntry(runtimeRejectedBlocks, {
          id: rejectedId,
          ...(moduleId ? { moduleId } : { blockId: aliasId || blockId }),
          reason
        });
      }
      selectionTrace.push({
        ...baseTrace,
        selected: false,
        decision: 'reject',
        usable: false,
        reason
      });
      continue;
    }

    selectedBlocks.push(block);
    ids.forEach((id) => selectedPlanIds.add(id));
    if (moduleId) selectedPlanIds.add(`persona_module:${moduleId}`);
    if (runtimeAdded && !includedByPlanner) {
      const addedId = planId;
      pushUniqueEntry(runtimeAddedBlocks, {
        id: addedId,
        ...(moduleId ? { moduleId } : { blockId: addedId }),
        reason: skippedByPlanner
          ? 'runtime_must_use_overrode_planner_skip'
          : (addedId === 'directed_context'
            ? 'directed context exists and is required to resolve current turn'
            : 'runtime must-use block')
      });
    }
    selectionTrace.push({
      ...baseTrace,
      selected: true,
      decision: 'include',
      usable: true,
      reason: runtimeAdded && skippedByPlanner
        ? 'runtime_must_use_overrode_planner_skip'
        : (runtimeAdded
          ? 'runtime_must_use'
          : (includedByPlanner ? 'planner_include' : (required ? 'required' : 'required_non_optional')))
    });
  }

  for (const blockId of enabledIds) {
    if (selectedPlanIds.has(blockId) || rejectedPlanIds.has(blockId)) continue;
    if (availablePlanIds.has(blockId)) continue;
    pushUniqueEntry(runtimeRejectedBlocks, {
      id: blockId,
      blockId,
      reason: 'unavailable_or_empty'
    });
    selectionTrace.push({
      id: blockId,
      blockId,
      lane: getDynamicContextBlockSpec(blockId).lane,
      category: getDynamicContextBlockSpec(blockId).category,
      criticality: getDynamicContextBlockSpec(blockId).criticality,
      selected: false,
      decision: 'reject',
      includedByPlanner: true,
      reason: 'unavailable_or_empty',
      estimatedTokens: 0,
      budgetTokens: 0,
      budgetConfigKey: ''
    });
  }
  for (const moduleId of enabledPersonaModules) {
    const id = `persona_module:${moduleId}`;
    if (selectedPlanIds.has(id) || rejectedPlanIds.has(id)) continue;
    if (availablePlanIds.has(id)) continue;
    pushUniqueEntry(runtimeRejectedBlocks, {
      id,
      moduleId,
      reason: 'unavailable_or_rejected'
    });
    const spec = getDynamicContextBlockSpec(id);
    selectionTrace.push({
      id,
      moduleId,
      lane: spec.lane,
      category: spec.category,
      criticality: spec.criticality,
      selected: false,
      decision: 'reject',
      includedByPlanner: true,
      reason: 'unavailable_or_rejected',
      estimatedTokens: 0,
      budgetTokens: 0,
      budgetConfigKey: ''
    });
  }

  return {
    selectedBlocks,
    selectionTrace,
    budgetReport: buildContextBudgetReport(selectionTrace, {
      budgetTokens: input.budgetTokens
    }),
    runtimeAddedBlocks,
    runtimeRejectedBlocks
  };
}

function isCriticalDynamicContextBlock(block = {}) {
  const { primaryId } = getPromptBlockPlanIds(block);
  const id = primaryId || normalizeText(block?.id);
  if (normalizeText(block?.lane || block?.cacheLane) === 'stable_system') return true;
  return getDynamicContextBlockSpec(id).criticality === 'critical';
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
    push('short_term_continuity', 'short-term continuity should anchor carry-over context');
    push('continuity_state', 'carry-over topic or open loop detected');
    push('summary', 'continuity benefits from a compact carry-over summary');
    push('retrieved_memory_lite', 'continuity may need recalled memory anchors');
  }
  if (input.hasShortTermContinuity) {
    push('short_term_continuity', 'short-term context is available for this turn');
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
    '- `short_term_continuity`: usually enable when available. It carries recent raw turns, restart summaries, and short-term state; it is the main defense against short-term amnesia.',
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
  DYNAMIC_CONTEXT_BLOCK_SPEC_OVERRIDES,
  MAIN_REPLY_DYNAMIC_BLOCKS,
  blockHasUsableDynamicContextContent,
  buildContextBudgetReport,
  buildMainReplyDynamicPromptGuide,
  buildHeuristicDynamicPromptPlan,
  estimatePromptTokens,
  getDynamicContextBlockSpec,
  getMainReplyDynamicBlockCatalog,
  getPromptBlockPlanIds,
  isCriticalDynamicContextBlock,
  selectDynamicContextBlocks
};

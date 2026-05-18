function cloneDynamicPromptPlan(plan = {}) {
  const normalized = plan && typeof plan === 'object' ? plan : {};
  return {
    schemaVersion: normalizeText(normalized.schemaVersion, DYNAMIC_CONTEXT_PLAN_VERSION),
    enabledBlockIds: normalizeArray(normalized.enabledBlockIds).map((item) => normalizeText(item)).filter(Boolean),
    personaModules: normalizeArray(normalized.personaModules).map((item) => normalizeText(item)).filter(Boolean),
    blockDecisions: normalizeArray(normalized.blockDecisions)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({ ...item })),
    rationaleByBlock: normalized.rationaleByBlock && typeof normalized.rationaleByBlock === 'object'
      ? { ...normalized.rationaleByBlock }
      : {},
    plannerProvided: normalized.plannerProvided === true,
    source: normalizeText(normalized.source || normalized._source || (normalized.plannerProvided ? 'planner' : 'heuristic')),
    _source: normalizeText(normalized._source || normalized.source || (normalized.plannerProvided ? 'planner' : 'heuristic'))
  };
}

function findPlannerDynamicPromptPlan(options = {}) {
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const candidates = [
    options?.dynamicPromptPlan,
    routeMeta?.directChatPlanner?.dynamicPromptPlan,
    routeMeta?.toolPlanner?.dynamicPromptPlan,
    routeMeta?.directChatPlanner?.plannerDecisionV2?.dynamicPromptPlan,
    routeMeta?.toolPlanner?.plannerDecisionV2?.dynamicPromptPlan,
    routeMeta?.directChatPlanner?.plannerDecisionV2?.plannerMeta?.dynamicPromptPlan,
    routeMeta?.toolPlanner?.plannerDecisionV2?.plannerMeta?.dynamicPromptPlan
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

function normalizePlannerBlockDecisions(plan = {}) {
  const decisions = [];
  const byKey = new Map();
  const addDecision = (raw = {}, fallback = {}) => {
    let blockId = normalizeText(raw.blockId || fallback.blockId);
    let moduleId = normalizeText(raw.moduleId || fallback.moduleId);
    if (!moduleId && blockId.startsWith('persona_module:')) {
      moduleId = normalizeText(blockId.slice('persona_module:'.length));
      blockId = '';
    }
    if (!blockId && !moduleId) return;
    const decision = normalizeText(raw.decision || fallback.decision).toLowerCase() === 'skip' ? 'skip' : 'include';
    const confidence = Number.isFinite(Number(raw.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : (decision === 'include' ? 0.8 : 0.5);
    const priority = Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 100;
    const reason = normalizeText(raw.reason || fallback.reason);
    const key = moduleId ? `persona_module:${moduleId}` : blockId;
    if (byKey.has(key)) return;
    byKey.set(key, {
      ...(moduleId ? { moduleId } : { blockId }),
      decision,
      confidence,
      priority,
      reason
    });
  };

  for (const decision of normalizeArray(plan.blockDecisions)) addDecision(decision);
  for (const blockId of normalizeArray(plan.enabledBlockIds).map((item) => normalizeText(item)).filter(Boolean)) {
    addDecision({ blockId }, {
      decision: 'include',
      reason: normalizeText(plan?.rationaleByBlock?.[blockId])
    });
  }
  for (const moduleId of normalizeArray(plan.personaModules).map((item) => normalizeText(item)).filter(Boolean)) {
    addDecision({ moduleId }, {
      decision: 'include',
      reason: normalizeText(plan?.rationaleByBlock?.[moduleId] || plan?.rationaleByBlock?.[`persona_module:${moduleId}`])
    });
  }

  decisions.push(...byKey.values());
  return decisions;
}

function normalizePlannerDynamicContextPlan(options = {}) {
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const plannerPlan = findPlannerDynamicPromptPlan(options);
  if (plannerPlan) {
    const blockDecisions = normalizePlannerBlockDecisions(plannerPlan);
    const skippedBlocks = new Set(blockDecisions.filter((item) => item.decision === 'skip' && item.blockId).map((item) => item.blockId));
    const skippedModules = new Set(blockDecisions.filter((item) => item.decision === 'skip' && item.moduleId).map((item) => item.moduleId));
    const enabledBlockIds = Array.from(new Set(
      normalizeArray(plannerPlan.enabledBlockIds)
        .map((item) => normalizeText(item))
        .filter((item) => item && !item.startsWith('persona_module:') && !skippedBlocks.has(item))
        .concat(blockDecisions.filter((item) => item.decision === 'include' && item.blockId).map((item) => item.blockId))
    )).filter((item) => !skippedBlocks.has(item));
    const personaModules = Array.from(new Set(
      normalizeArray(plannerPlan.personaModules)
        .concat(normalizeArray(routeMeta?.directChatPlanner?.personaModules || routeMeta?.toolPlanner?.personaModules))
        .map((item) => normalizeText(item))
        .filter((item) => item && !skippedModules.has(item))
        .concat(blockDecisions.filter((item) => item.decision === 'include' && item.moduleId).map((item) => item.moduleId))
    )).filter((item) => !skippedModules.has(item));
    const plannerNormalized = {
      schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
      enabledBlockIds,
      personaModules,
      blockDecisions,
      rationaleByBlock: plannerPlan.rationaleByBlock && typeof plannerPlan.rationaleByBlock === 'object'
        ? { ...plannerPlan.rationaleByBlock }
        : {},
      plannerProvided: !['heuristic', 'rule', 'fallback'].includes(normalizeText(plannerPlan._source || plannerPlan.source)),
      source: normalizeText(plannerPlan._source || plannerPlan.source) || 'planner',
      _source: normalizeText(plannerPlan._source || plannerPlan.source) || 'planner'
    };
    return ensureGroupDirectPersonaModulePlan(plannerNormalized, options);
  }

  const heuristicPlan = buildHeuristicDynamicPromptPlan({
    continuitySignals: options?.continuitySignals,
    directedContext: options?.routeMeta?.directedContext,
    personaModules: normalizeArray(options?.routeMeta?.directChatPlanner?.personaModules || options?.routeMeta?.toolPlanner?.personaModules),
    hasAffinityState: true
  });
  const fallbackPlan = {
    schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
    ...heuristicPlan,
    blockDecisions: normalizePlannerBlockDecisions(heuristicPlan),
    plannerProvided: false,
    source: 'heuristic',
    _source: 'heuristic'
  };
  return ensureGroupDirectPersonaModulePlan(fallbackPlan, options);
}

function normalizeDynamicPromptPlan(options = {}) {
  return normalizePlannerDynamicContextPlan(options);
}

function createDynamicContextAudit(dynamicPromptPlan = {}) {
  const included = [];
  const skipped = [];
  for (const decision of normalizeArray(dynamicPromptPlan.blockDecisions)) {
    const id = normalizeText(decision.blockId || (decision.moduleId ? `persona_module:${decision.moduleId}` : ''));
    if (!id) continue;
    const entry = {
      id,
      ...(decision.blockId ? { blockId: decision.blockId } : {}),
      ...(decision.moduleId ? { moduleId: decision.moduleId } : {}),
      confidence: Number.isFinite(Number(decision.confidence)) ? Number(decision.confidence) : undefined,
      priority: Number.isFinite(Number(decision.priority)) ? Number(decision.priority) : undefined,
      reason: normalizeText(decision.reason)
    };
    if (decision.decision === 'skip') skipped.push(entry);
    else included.push(entry);
  }
  return {
    plannerDynamicContextPlan: cloneDynamicPromptPlan(dynamicPromptPlan),
    plannerIncludedBlocks: included,
    plannerSkippedBlocks: skipped,
    runtimeAddedBlocks: [],
    runtimeRejectedBlocks: []
  };
}

function pushUniqueAuditEntry(list = [], entry = {}) {
  const id = normalizeText(entry.id || entry.blockId || (entry.moduleId ? `persona_module:${entry.moduleId}` : ''));
  const reason = normalizeText(entry.reason);
  if (!id) return;
  if (list.some((item) => normalizeText(item.id || item.blockId || (item.moduleId ? `persona_module:${item.moduleId}` : '')) === id && normalizeText(item.reason) === reason)) return;
  list.push({ id, ...entry });
}

function getPromptBlockPlanIds(block = {}) {
  const blockId = normalizeText(block?.id);
  const aliasId = normalizeText(block?.meta?.blockId);
  const moduleId = normalizeText(block?.meta?.moduleId);
  return {
    blockId,
    aliasId,
    moduleId,
    ids: [blockId, aliasId].filter(Boolean)
  };
}

function blockHasUsableContent(block = {}) {
  const content = normalizeText(block?.content);
  if (!content) return false;
  const { blockId, aliasId } = getPromptBlockPlanIds(block);
  const key = aliasId || blockId;
  const emptyPatternByBlock = {
    retrieved_memory_lite: /\[RetrievedMemoryLite\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    daily_journal: /\[DailyJournal\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    long_term_profile: /\[LongTermProfile\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    impression: /\[Impression\]\s*(?:none|null|undefined|暂无|无)?\s*$/i,
    summary: /\[Summary\]\s*(?:none|null|undefined|暂无|无)?\s*$/i
  };
  const pattern = emptyPatternByBlock[key];
  if (pattern && pattern.test(content)) return false;
  return true;
}

function filterBlocksByPlan(blocks = [], dynamicPromptPlan = {}, options = {}) {
  const selection = selectDynamicContextBlocks({
    blocks,
    dynamicPromptPlan,
    requiredIds: options.requiredIds,
    runtimeAddedIds: options.runtimeAddedIds,
    budgetTokens: options.budgetTokens
  });
  const audit = options.audit && typeof options.audit === 'object' ? options.audit : null;
  if (audit) {
    for (const entry of normalizeArray(selection.runtimeAddedBlocks)) {
      pushUniqueAuditEntry(audit.runtimeAddedBlocks, entry);
    }
    for (const entry of normalizeArray(selection.runtimeRejectedBlocks)) {
      pushUniqueAuditEntry(audit.runtimeRejectedBlocks, entry);
    }
    audit.selectionTrace = normalizeArray(audit.selectionTrace).concat(selection.selectionTrace);
    audit.budgetReport = selection.budgetReport;
  }
  return selection.selectedBlocks;
}


const {
  DIRECT_CHAT_PLANNER_VERSION,
  DYNAMIC_CONTEXT_PLAN_VERSION,
  PLANNER_DECISION_VERSION,
  TASK_SHAPES,
  clampNumber,
  clampReason,
  normalizeArray,
  normalizeChatMode,
  normalizeObject,
  normalizeResponseIntent,
  normalizeText,
  normalizeToolIntent,
  normalizeToolNames
} = require('./runtime-core.chunk');

function normalizeDynamicPromptPlan(plan = {}, options = {}) {
  const personaModuleCatalog = normalizeArray(options.personaModuleCatalog);
  const blockCatalog = normalizeArray(options.dynamicPromptBlockCatalog);
  const legacyPersonaModules = normalizeArray(options.legacyPersonaModules);
  const planSource = normalizeText(options.source || plan?.source || plan?._source || 'planner');
  const unavailableBlocks = new Set(normalizeArray(options.unavailableBlockIds).map((item) => normalizeText(item)).filter(Boolean));
  const plannerProvided = options.plannerProvided !== undefined
    ? options.plannerProvided === true
    : !['heuristic', 'rule', 'fallback'].includes(planSource);
  const validDynamicBlockIds = new Set(
    blockCatalog
      .map((item) => normalizeText(item?.blockId))
      .filter((blockId) => blockId && !blockId.startsWith('persona_module:'))
  );
  const validPersonaModuleIds = new Set(
    personaModuleCatalog
      .map((item) => normalizeText(item?.moduleId))
      .filter(Boolean)
  );
  const rationaleSource = normalizeObject(plan?.rationaleByBlock, {});
  const explicitDecisions = new Map();
  const enabledBlockSet = new Set();
  const skippedBlockSet = new Set();
  const personaModuleSet = new Set();
  const skippedPersonaModuleSet = new Set();
  const legacyEnabledBlockIds = normalizeArray(plan?.enabledBlockIds)
    .map((item) => normalizeText(item))
    .filter((blockId) => validDynamicBlockIds.has(blockId))
    .filter((blockId) => !unavailableBlocks.has(blockId));
  const personaModuleLimit = Math.max(
    1,
    Number(options.maxActivePersonaModules || options.maxActiveModules || 0)
    || Math.min(8, Math.max(1, personaModuleCatalog.length || 1))
  );
  const legacyPlanPersonaModules = normalizeArray(plan?.personaModules)
    .concat(legacyPersonaModules)
    .map((item) => normalizeText(item))
    .filter((moduleId) => validPersonaModuleIds.has(moduleId))
    .filter((moduleId, index, list) => list.indexOf(moduleId) === index);

  for (const rawDecision of normalizeArray(plan?.blockDecisions)) {
    if (!rawDecision || typeof rawDecision !== 'object') continue;
    let blockId = normalizeText(rawDecision.blockId);
    let moduleId = normalizeText(rawDecision.moduleId);
    if (!moduleId && blockId.startsWith('persona_module:')) {
      moduleId = normalizeText(blockId.slice('persona_module:'.length));
    }
    const isPersonaModule = Boolean(moduleId);
    if (isPersonaModule && !validPersonaModuleIds.has(moduleId)) continue;
    if (!isPersonaModule && (!validDynamicBlockIds.has(blockId) || unavailableBlocks.has(blockId))) continue;
    if (isPersonaModule) blockId = normalizeText(blockId) || `persona_module:${moduleId}`;
    const decision = normalizeText(rawDecision.decision).toLowerCase() === 'skip' ? 'skip' : 'include';
    const key = isPersonaModule ? `persona_module:${moduleId}` : blockId;
    explicitDecisions.set(key, {
      ...(isPersonaModule ? { moduleId } : { blockId }),
      decision,
      confidence: clampNumber(rawDecision.confidence, 0, 1, decision === 'include' ? 0.75 : 0.5),
      priority: Number.isFinite(Number(rawDecision.priority)) ? Number(rawDecision.priority) : 100,
      reason: clampReason(normalizeText(rawDecision.reason), 180)
    });
  }

  for (const decision of explicitDecisions.values()) {
    if (decision.moduleId) {
      if (decision.decision === 'skip') skippedPersonaModuleSet.add(decision.moduleId);
      else personaModuleSet.add(decision.moduleId);
    } else if (decision.blockId) {
      if (decision.decision === 'skip') skippedBlockSet.add(decision.blockId);
      else enabledBlockSet.add(decision.blockId);
    }
  }

  for (const blockId of legacyEnabledBlockIds) {
    if (skippedBlockSet.has(blockId)) continue;
    enabledBlockSet.add(blockId);
    if (!explicitDecisions.has(blockId)) {
      explicitDecisions.set(blockId, {
        blockId,
        decision: 'include',
        confidence: 0.8,
        priority: 100,
        reason: clampReason(normalizeText(rationaleSource[blockId]), 180)
      });
    }
  }

  for (const moduleId of legacyPlanPersonaModules) {
    if (skippedPersonaModuleSet.has(moduleId)) continue;
    personaModuleSet.add(moduleId);
    const key = `persona_module:${moduleId}`;
    if (!explicitDecisions.has(key)) {
      explicitDecisions.set(key, {
        moduleId,
        decision: 'include',
        confidence: 0.8,
        priority: 100,
        reason: clampReason(
          normalizeText(rationaleSource[moduleId] || rationaleSource[key]),
          180
        )
      });
    }
  }

  for (const blockId of skippedBlockSet) enabledBlockSet.delete(blockId);
  for (const blockId of unavailableBlocks) enabledBlockSet.delete(blockId);
  for (const moduleId of skippedPersonaModuleSet) personaModuleSet.delete(moduleId);

  const enabledBlockIds = Array.from(enabledBlockSet);
  const personaModules = Array.from(personaModuleSet).slice(0, personaModuleLimit);
  const rationaleByBlock = {};

  for (const blockId of enabledBlockIds) {
    const reason = clampReason(normalizeText(rationaleSource[blockId]), 160);
    if (reason) rationaleByBlock[blockId] = reason;
  }
  for (const moduleId of personaModules) {
    const reason = clampReason(
      normalizeText(
        rationaleSource[moduleId]
        || rationaleSource[`persona_module:${moduleId}`]
      ),
      160
    );
    if (reason) rationaleByBlock[moduleId] = reason;
  }

  return {
    schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
    enabledBlockIds,
    personaModules,
    blockDecisions: Array.from(explicitDecisions.values()).filter((decision) => (
      !decision.moduleId || personaModules.includes(decision.moduleId) || decision.decision === 'skip'
    )),
    rationaleByBlock,
    plannerProvided,
    source: planSource,
    _source: planSource
  };
}

function getPlannerDecisionVersion() {
  return PLANNER_DECISION_VERSION;
}

function buildToolCatalogByName(toolCatalog = []) {
  return new Map(
    normalizeArray(toolCatalog)
      .filter((item) => item && typeof item === 'object')
      .map((item) => [normalizeText(item.name), { ...item }])
      .filter(([name]) => Boolean(name))
  );
}

function resolveToolBucket(toolName = '', toolCatalogByName = new Map()) {
  return normalizeText(toolCatalogByName.get(normalizeText(toolName))?.bucket) || 'local_tools';
}

function inferToolBucket(toolName = '') {
  const normalized = normalizeText(toolName);
  if (/^mcp_/i.test(normalized)) return 'mcp';
  if (/^skill_/i.test(normalized)) return 'skills';
  return 'local_tools';
}

function buildExplicitAllowedToolCatalog(toolNames = []) {
  return normalizeToolNames(toolNames).map((toolName) => {
    const writeCapable = /schedule|publish|create|delete|cancel|append|write|update/i.test(toolName);
    return {
      name: toolName,
      bucket: inferToolBucket(toolName),
      description: toolName,
      readOnly: !writeCapable,
      writeCapable
    };
  });
}

function isWriteCapableTool(toolCatalogByName = new Map(), toolName = '') {
  const item = toolCatalogByName.get(normalizeText(toolName));
  if (!item) return false;
  if (item.writeCapable === true) return true;
  if (item.readOnly === true) return false;
  return Boolean(item?.writeCapable)
    || Boolean(item && item.readOnly === false && /schedule|publish|create|delete|cancel|append|write|update/i.test(normalizeText(item.name)));
}

function buildExecutionStepGraph({
  tool = '',
  args = {},
  purpose = '',
  route = {},
  index = 0,
  options = {}
} = {}) {
  const normalizedTool = normalizeText(tool);
  const runtimeBinding = normalizeObject(options.runtimeBinding, null);
  const dependsOn = normalizeArray(options.dependsOn).map((item) => normalizeText(item)).filter(Boolean);
  const sideEffect = Boolean(options.sideEffect);
  return {
    id: normalizeText(options.id) || `planner_step_${index + 1}`,
    tool: normalizedTool,
    args: normalizeObject(args, {}),
    kind: normalizeText(options.kind) || (Boolean(options.contextEvidence) ? 'context_evidence' : 'tool'),
    dependsOn,
    parallelGroup: normalizeText(options.parallelGroup),
    sideEffect,
    successCriteria: clampReason(
      normalizeText(options.successCriteria)
      || normalizeText(purpose)
      || `Use ${normalizedTool}`
    , 240),
    evidenceRequirement: normalizeObject(options.evidenceRequirement, {
      type: 'tool_result',
      minCount: 1,
      requireCompleted: true
    }),
    repairPolicy: normalizeObject(options.repairPolicy, {
      strategy: sideEffect ? 'never_retry_completed_side_effect' : 'retry_step',
      allowModelRepair: !sideEffect
    }),
    runtimeBinding: runtimeBinding ? { ...runtimeBinding } : null,
    purpose: clampReason(normalizeText(purpose) || `Use ${normalizedTool}`, 240),
    source: normalizeText(options.source) || 'planner_v2',
    routeContext: {
      chatMode: normalizeChatMode(route?.meta?.chatMode),
      responseIntent: normalizeResponseIntent(route?.meta?.responseIntent),
      toolIntent: normalizeToolIntent(route?.meta?.toolIntent)
    }
  };
}

function convertPlannerStepGraphToLegacyStep(step = {}, index = 0) {
  return {
    id: normalizeText(step.id) || `direct_chat_step_${index + 1}`,
    action: normalizeText(step.tool),
    args: normalizeObject(step.args, {}),
    purpose: normalizeText(step.purpose || step.successCriteria) || `Use ${normalizeText(step.tool)}`
  };
}

function buildLegacyExecutionPlanFromSteps(steps = []) {
  const normalized = normalizeArray(steps);
  if (normalized.length === 0) {
    return {
      mode: 'chat_only',
      steps: [],
      finalResponseMode: 'synthesize_after_tools',
      plannerVersion: DIRECT_CHAT_PLANNER_VERSION
    };
  }
  return {
    mode: 'tool_plan',
    steps: normalized.map(convertPlannerStepGraphToLegacyStep),
    finalResponseMode: 'synthesize_after_tools',
    plannerVersion: DIRECT_CHAT_PLANNER_VERSION
  };
}

function buildValidationEnvelope({
  mode = 'chat_only',
  taskShape = 'fast_reply',
  steps = [],
  goal = '',
  plannerMeta = {}
} = {}) {
  const normalizedSteps = normalizeArray(steps);
  return {
    mode: normalizeText(mode) || 'chat_only',
    taskShape: TASK_SHAPES.includes(normalizeText(taskShape)) ? normalizeText(taskShape) : 'fast_reply',
    step_statuses: normalizedSteps.map((step) => ({
      step_id: normalizeText(step.id),
      tool: normalizeText(step.tool),
      required: !Boolean(step.optional),
      evidenceRequirement: normalizeObject(step.evidenceRequirement, {}),
      repairPolicy: normalizeObject(step.repairPolicy, {})
    })),
    unsatisfied_requirements: [],
    retryable_steps: normalizedSteps
      .filter((step) => normalizeObject(step.repairPolicy, {}).strategy !== 'never_retry_completed_side_effect')
      .map((step) => normalizeText(step.id))
      .filter(Boolean),
    goal_coverage: {
      goal: normalizeText(goal),
      strategy: normalizedSteps.length > 0 ? 'tool_evidence' : 'direct_reply'
    },
    repair_strategy: {
      deterministicFirst: true,
      allowModelRepair: normalizedSteps.some((step) => normalizeObject(step.repairPolicy, {}).allowModelRepair !== false)
    },
    plannerMeta: normalizeObject(plannerMeta, {})
  };
}

module.exports = {
  buildExecutionStepGraph,
  buildExplicitAllowedToolCatalog,
  buildLegacyExecutionPlanFromSteps,
  buildToolCatalogByName,
  buildValidationEnvelope,
  convertPlannerStepGraphToLegacyStep,
  getPlannerDecisionVersion,
  inferToolBucket,
  isWriteCapableTool,
  normalizeDynamicPromptPlan,
  resolveToolBucket
};


const {
  DEFAULT_WORLDBOOK_PLANNER_CANDIDATE_LIMIT,
  DIRECT_CHAT_PLANNER_VERSION,
  DYNAMIC_CONTEXT_PLAN_VERSION,
  PLANNER_DECISION_VERSION,
  PLANNER_PROTOCOL_VERSION,
  TASK_SHAPES,
  TOOL_BUCKETS,
  buildDirectChatToolCatalogSummary,
  buildMainReplyDynamicPromptGuide,
  buildPlannerPersonaModuleCatalog,
  buildPlannerStageSystemPrompt,
  clampNumber,
  config,
  getMainReplyDynamicBlockCatalog,
  getPersonaModuleCatalogSummary,
  getPlannerRequestText,
  isConversationalNoop,
  isSubjectiveOpinionQuestion,
  normalizeArray,
  normalizeChatMode,
  normalizeObject,
  normalizePlannerLatencyMeta,
  normalizeResponseIntent,
  normalizeText,
  normalizeToolIntent,
  normalizeToolNames,
  shouldPrioritizeMemoryProbe
} = require('./runtime-core.chunk');
const {
  buildExecutionStepGraph,
  buildToolCatalogByName,
  buildValidationEnvelope,
  getPlannerDecisionVersion,
  normalizeDynamicPromptPlan,
  resolveToolBucket
} = require('./dynamic-plan.chunk');
const {
  buildBackgroundResearchMeta,
  choosePreferredToolSubset,
  collectAvailableToolSummary,
  getPlannerModel,
  isCompanionPlannerMode,
  isCompanionPlannerToolUseAllowed,
  normalizePlannerReasonText,
  resolveCompanionPlannerToolGateReason
} = require('./tool-gating.chunk');
const {
  buildPlannerStepGraphSequence,
  deriveToolArgs,
  shouldForceWebSearchFetchPlan
} = require('./tool-selection.chunk');
const {
  buildAvailableContextSignals,
  buildRuleBasedPlannerDecision,
  isDynamicPromptBlockAvailable,
  normalizeDynamicPromptBlockCatalogForPlanner,
  sanitizePlannerContextSummary,
  summarizeToolCatalogForPrompt
} = require('./rule-decision.chunk');

function buildPlannerPrompt(toolCatalog = []) {
  const catalogBlock = summarizeToolCatalogForPrompt(toolCatalog);
  return [
    buildPlannerStageSystemPrompt(toolCatalog),
    'Decide the complete tool decision and execution graph in one pass.',
    'First build a compact semantic understanding of the request: user intent, source scope, temporal/freshness need, context dependencies, constraints, ambiguity, and whether tool evidence is necessary.',
    `"plannerMeta.decisionVersion" must be exactly "${PLANNER_DECISION_VERSION}".`,
    `"plannerMeta.plannerVersion" must be exactly "${DIRECT_CHAT_PLANNER_VERSION}".`,
    'mode must be exactly chat_only or tool_plan.',
    'taskShape must be exactly fast_reply, tool_augmented_reply, or background_tool_task.',
    'Only choose tools from the provided allowlist and catalog.',
    'Do not invent tool names.',
    'If the request depends on freshness, memory, notebook retrieval, web facts, current time, or explicit action execution, prefer tool_plan.',
    'If the request needs write-capable or side-effect tools, taskShape must be background_tool_task.',
    'Keep the full candidate set, but choose the most specialized applicable tool when overlap exists.',
    'Prefer notebook tools for notebook content, memory_cli for continuity recall, and never substitute one for the other.',
    'Prefer specialist weather, finance, arxiv, time, and context tools over generic web search when the request clearly matches that domain.',
    'If an explicit URL is already known, prefer fetch/extract over search-first discovery.',
    'If you choose memory_cli for recall or notebook continuity, search first. Plan a follow-up memory_cli open only when the search result alone is likely insufficient.',
    'If the user asks for official docs, website details, key points, or asks to include links and both web_search and web_fetch are available, plan web_search first and web_fetch second.',
    'You may output personaModules as a top-level array and/or plannerMeta.personaModules; respect catalog/runtime limits and prefer a small useful set.',
    'You must output dynamicPromptPlan as a top-level object and may mirror it under plannerMeta.dynamicPromptPlan for compatibility.',
    `dynamicPromptPlan.schemaVersion must be exactly "${DYNAMIC_CONTEXT_PLAN_VERSION}".`,
    'Dynamic context policy is availability-gated: only include a block when dynamicPromptBlockCatalog.available is true, except persona modules which use personaModules.',
    'Selection policy: must_use_when_available blocks are required when available; include_if_relevant blocks need clear turn-level value; high_value_only blocks need specific information gain; tool_policy_only blocks require the corresponding tool exposure.',
    'Never include empty, unavailable, conflicting, or purely noisy dynamic blocks.',
    'For ordinary self-contained questions, skip memory/profile blocks unless availableContextSignals shows real content and the block helps the answer.',
    'MemOS recall is internal planner-side evidence. You may enable memos_recall when it contains specific useful memory, but never expose or request MemOS MCP tools in allowedToolNames.',
    'Use enabledBlockIds only for non-persona dynamic blocks. Use personaModules only for persona modules.',
    'For every important include or skip, add a blockDecisions item with decision, confidence, priority, and a short reason.',
    'Set plannerMeta.semanticConfidence from 0 to 1. Use >=0.86 only when intent, tools, and context selection are clear; use <0.72 when there is meaningful ambiguity, weak source-scope understanding, or an incomplete graph.',
    'Set plannerMeta.needsSemanticRefinement=false. This runtime allows one planner model call only, so return the best final decision now.',
    'Always include plannerMeta.semanticAssessment with intentSummary, sourceScope, contextDependencies, ambiguity, confidence, and needsRefinement.',
    'If semanticRefinement is present in the user payload from older callers, address it inside this same response and do not request another pass.',
    'steps items must include: id, tool, args, kind, dependsOn, parallelGroup, sideEffect, successCriteria, evidenceRequirement, repairPolicy, runtimeBinding, purpose.',
    'Available tools right now:',
    catalogBlock,
    'Output schema:',
    '{',
    '  "mode": "tool_plan",',
    '  "taskShape": "tool_augmented_reply",',
    '  "allowedToolNames": ["tool_name"],',
    '  "dynamicPromptPlan": {',
    `    "schemaVersion": "${DYNAMIC_CONTEXT_PLAN_VERSION}",`,
    '    "enabledBlockIds": ["directed_context"],',
    '    "personaModules": ["scene_private_chat"],',
    '    "blockDecisions": [{"blockId":"directed_context","decision":"include","confidence":0.92,"priority":10,"reason":"quoted reply needs disambiguation"},{"moduleId":"scene_private_chat","decision":"include","confidence":0.84,"priority":40,"reason":"private disclosure scene"}],',
    '    "rationaleByBlock": {"directed_context":"quoted reply needs disambiguation","scene_private_chat":"private disclosure scene"}',
    '  },',
    '  "personaModules": ["scene_private_chat"],',
    '  "steps": [{"id":"planner_step_1","tool":"tool_name","args":{},"kind":"tool","dependsOn":[],"parallelGroup":"","sideEffect":false,"successCriteria":"...","evidenceRequirement":{"type":"tool_result","minCount":1,"requireCompleted":true},"repairPolicy":{"strategy":"retry_step","allowModelRepair":true},"runtimeBinding":null,"purpose":"..."}],',
    '  "plannerMeta": {',
    `    "decisionVersion": "${PLANNER_DECISION_VERSION}",`,
    `    "plannerVersion": "${DIRECT_CHAT_PLANNER_VERSION}",`,
    '    "reason": "short reason",',
    '    "semanticConfidence": 0.88,',
    '    "needsSemanticRefinement": false,',
    '    "semanticAssessment": {"intentSummary":"short intent","sourceScope":"current_context|memory|notebook|web|live|action|none","contextDependencies":["directed_context"],"ambiguity":[],"confidence":0.88,"needsRefinement":false},',
    '    "dynamicPromptPlan": {',
    `      "schemaVersion": "${DYNAMIC_CONTEXT_PLAN_VERSION}",`,
    '      "enabledBlockIds": ["directed_context"],',
    '      "personaModules": ["scene_private_chat"],',
    '      "blockDecisions": [{"blockId":"directed_context","decision":"include","confidence":0.92,"priority":10,"reason":"quoted reply needs disambiguation"}],',
    '      "rationaleByBlock": {',
    '        "directed_context": "quoted reply needs disambiguation",',
    '        "scene_private_chat": "private disclosure scene" ',
    '      }',
    '    }',
    '  }',
    '}'
  ].join('\n');
}

function buildPlannerUserPayload(route = {}, toolCatalog = [], options = {}) {
  const routeMeta = normalizeObject(route?.meta, {});
  const allowlist = normalizeToolNames(
    Array.isArray(options?.allowedTools)
      ? options.allowedTools
      : routeMeta.allowedTools
  );
  const personaModuleCatalog = normalizeArray(options?.personaModuleCatalog).length > 0
    ? normalizeArray(options.personaModuleCatalog)
    : getPersonaModuleCatalogSummary();
  const plannerPersonaModuleCatalog = buildPlannerPersonaModuleCatalog(personaModuleCatalog, {
    question: normalizeText(options.question || route?.question || route?.cleanText),
    routePrompt: options.routePrompt,
    routeMeta,
    directedContext: options?.directedContext || routeMeta.directedContext,
    continuitySignals: options?.continuitySignals || routeMeta.continuitySignals,
    personaPhase: routeMeta.personaPhase || ''
  }, {
    limit: Math.max(
      0,
      Math.floor(Number(
        options.worldbookPlannerCandidateLimit
        ?? config.PERSONA_WORLDBOOK_PLANNER_CANDIDATE_LIMIT
        ?? DEFAULT_WORLDBOOK_PLANNER_CANDIDATE_LIMIT
      ) || DEFAULT_WORLDBOOK_PLANNER_CANDIDATE_LIMIT)
    )
  });
  const dynamicPromptBlockCatalog = normalizeArray(options?.dynamicPromptBlockCatalog).length > 0
    ? normalizeArray(options.dynamicPromptBlockCatalog)
    : getMainReplyDynamicBlockCatalog(plannerPersonaModuleCatalog);
  const availableContextSignals = buildAvailableContextSignals(route, options);
  const semanticRefinement = normalizeObject(options?.semanticRefinement || routeMeta.semanticRefinement, null);
  return {
    question: normalizeText(options.question || route?.question || route?.cleanText),
    cleanText: normalizeText(route?.cleanText),
    effectiveIntentText: getPlannerRequestText(route),
    imageUrl: route?.imageUrl || null,
    topRouteType: normalizeText(options.topRouteType || route?.topRouteType || 'direct_chat') || 'direct_chat',
    chatMode: normalizeChatMode(route?.meta?.chatMode),
    toolIntent: normalizeToolIntent(route?.meta?.toolIntent),
    responseIntent: normalizeResponseIntent(route?.meta?.responseIntent),
    intent: normalizeObject(route?.intent, {}),
    facets: normalizeObject(route?.facets, {}),
    safetyBoundary: routeMeta.safetyBoundary === true,
    contextSummary: sanitizePlannerContextSummary(
      options?.contextSummary
      || routeMeta.sessionContextSummary
      || routeMeta.contextSummary
      || routeMeta.conversationSummary
      || '',
      360
    ),
    directedContext: normalizeObject(options?.directedContext || routeMeta.directedContext, null),
    continuitySignals: normalizeObject(options?.continuitySignals || routeMeta.continuitySignals, {}),
    memosRecall: normalizeObject(options?.memosRecall || routeMeta.memosRecall || routeMeta.directChatPlanner?.memosRecall || routeMeta.toolPlanner?.memosRecall, {}),
    availableContextSignals,
    semanticContext: {
      intentText: getPlannerRequestText(route),
      contextSummary: sanitizePlannerContextSummary(
        options?.contextSummary
        || routeMeta.sessionContextSummary
        || routeMeta.contextSummary
        || routeMeta.conversationSummary
        || '',
        360
      ),
      directedContext: normalizeObject(options?.directedContext || routeMeta.directedContext, null),
      continuitySignals: normalizeObject(options?.continuitySignals || routeMeta.continuitySignals, {}),
      availableContextSignals,
      memorySignals: {
        hasRetrievedMemory: availableContextSignals.retrievedMemory === true,
        hasMemosRecall: availableContextSignals.memosRecall === true,
        hasDailyJournal: availableContextSignals.dailyJournal === true,
        hasShortTermContinuity: availableContextSignals.shortTermContinuity === true,
        hasLongTermProfile: availableContextSignals.longTermProfile === true
      },
      toolDecisionHints: {
        explicitAllowlist: allowlist,
        toolIntent: normalizeToolIntent(route?.meta?.toolIntent),
        responseIntent: normalizeResponseIntent(route?.meta?.responseIntent),
        freshness: normalizeText(route?.facets?.freshness),
        domain: normalizeText(route?.facets?.domain),
        sourceScope: normalizeText(route?.facets?.sourceScope)
      }
    },
    ...(semanticRefinement ? { semanticRefinement } : {}),
    constraints: normalizeObject(options?.constraints, {}),
    explicitAllowlist: allowlist,
    tools: buildDirectChatToolCatalogSummary(toolCatalog),
    personaModuleCatalog: plannerPersonaModuleCatalog,
    dynamicPromptBlockCatalog: normalizeDynamicPromptBlockCatalogForPlanner(dynamicPromptBlockCatalog, availableContextSignals),
    dynamicPromptGuide: normalizeText(options?.dynamicPromptGuide)
      || buildMainReplyDynamicPromptGuide(
        plannerPersonaModuleCatalog
      )
  };
}

function normalizeRuntimeBindingDescriptor(step = {}, route = {}) {
  const toolName = normalizeText(step?.tool);
  const dependsOn = normalizeArray(step?.dependsOn).map((item) => normalizeText(item)).filter(Boolean);
  const rawBinding = step?.runtimeBinding === null ? null : normalizeObject(step?.runtimeBinding, null);
  if (rawBinding && normalizeText(rawBinding.type)) {
    const normalizedType = normalizeText(rawBinding.type);
    const fallbackSourceStepId = dependsOn[0] || '';
    return {
      ...rawBinding,
      type: normalizedType,
      sourceStepId: normalizedType === 'best_url_from_previous_search' || normalizedType === 'memory_ref_from_previous_search'
        ? fallbackSourceStepId || normalizeText(rawBinding.sourceStepId || rawBinding.source_step_id)
        : normalizeText(rawBinding.sourceStepId || rawBinding.source_step_id || fallbackSourceStepId),
      sourceTool: normalizeText(rawBinding.sourceTool || rawBinding.source_tool)
        || (normalizedType === 'best_url_from_previous_search' ? 'web_search' : (normalizedType === 'memory_ref_from_previous_search' ? 'memory_cli' : '')),
      targetArg: normalizeText(rawBinding.targetArg || rawBinding.target_arg)
        || (normalizedType === 'best_url_from_previous_search' ? 'url' : (normalizedType === 'memory_ref_from_previous_search' ? 'command' : ''))
    };
  }

  const bindingEntries = rawBinding ? Object.entries(rawBinding).filter(([key]) => normalizeText(key)) : [];
  const sourceStepIdFromKey = normalizeText(bindingEntries[0]?.[0] || '').split('.')[0];
  const sourceStepId = sourceStepIdFromKey || dependsOn[0] || '';

  if (toolName === 'memory_cli') {
    const command = normalizeText(step?.args?.command);
    if ((rawBinding && bindingEntries.length > 0) || /\{\{.*topRef.*\}\}/i.test(command) || !command || /^mem open --ref\s*$/i.test(command)) {
      return {
        type: 'memory_ref_from_previous_search',
        sourceStepId: sourceStepId || 'planner_step_1',
        sourceTool: 'memory_cli',
        targetArg: 'command'
      };
    }
  }

  if (toolName === 'web_fetch') {
    const url = normalizeText(step?.args?.url);
    if ((rawBinding && bindingEntries.length > 0) || !url) {
      return {
        type: 'best_url_from_previous_search',
        sourceStepId: sourceStepId || 'planner_step_1',
        sourceTool: 'web_search',
        targetArg: 'url'
      };
    }
  }

  return rawBinding ? { ...rawBinding } : null;
}

function pruneUnavailableDynamicPromptPlan(plan = {}, route = {}, options = {}) {
  const availableContextSignals = buildAvailableContextSignals(route, options);
  const enabledBlockIds = normalizeArray(plan.enabledBlockIds)
    .map((item) => normalizeText(item))
    .filter((blockId) => blockId && isDynamicPromptBlockAvailable(blockId, availableContextSignals));
  const enabledSet = new Set(enabledBlockIds);
  const blockDecisions = normalizeArray(plan.blockDecisions).filter((decision) => {
    const blockId = normalizeText(decision?.blockId);
    if (!blockId) return true;
    if (normalizeText(decision?.decision).toLowerCase() === 'skip') return true;
    return enabledSet.has(blockId) || isDynamicPromptBlockAvailable(blockId, availableContextSignals);
  });
  const rationaleByBlock = {};
  const sourceRationale = normalizeObject(plan.rationaleByBlock, {});
  for (const [key, value] of Object.entries(sourceRationale)) {
    const blockId = normalizeText(key);
    if (!blockId || !blockId.includes('_')) {
      rationaleByBlock[key] = value;
      continue;
    }
    if (enabledSet.has(blockId) || isDynamicPromptBlockAvailable(blockId, availableContextSignals)) {
      rationaleByBlock[key] = value;
    }
  }
  return {
    ...plan,
    enabledBlockIds,
    blockDecisions,
    rationaleByBlock
  };
}

function normalizePlannerDecisionV2(rawDecision = {}, route = {}, options = {}) {
  const fallback = buildRuleBasedPlannerDecision(route, options);
  const available = collectAvailableToolSummary(route, options);
  const toolCatalogByName = buildToolCatalogByName(available.toolCatalog);
  const personaModuleCatalog = normalizeArray(options.personaModuleCatalog).length > 0
    ? normalizeArray(options.personaModuleCatalog)
    : getPersonaModuleCatalogSummary();
  const dynamicPromptBlockCatalog = normalizeArray(options.dynamicPromptBlockCatalog).length > 0
    ? normalizeArray(options.dynamicPromptBlockCatalog)
    : getMainReplyDynamicBlockCatalog(personaModuleCatalog);
  const maxActivePersonaModules = Math.max(
    1,
    ...personaModuleCatalog.map((item) => Number(item?.maxActiveModules || 0) || 0),
    3
  );
  const rawDynamicPromptPlan = rawDecision?.dynamicPromptPlan || rawDecision?.plannerMeta?.dynamicPromptPlan;
  const hasRawDynamicPromptPlan = rawDynamicPromptPlan && typeof rawDynamicPromptPlan === 'object' && !Array.isArray(rawDynamicPromptPlan);
  const normalizedDynamicPromptPlan = pruneUnavailableDynamicPromptPlan(normalizeDynamicPromptPlan(
    hasRawDynamicPromptPlan
      ? rawDynamicPromptPlan
      : (fallback?.dynamicPromptPlan || fallback?.plannerMeta?.dynamicPromptPlan || {}),
    {
      personaModuleCatalog,
      dynamicPromptBlockCatalog,
      legacyPersonaModules: rawDecision?.plannerMeta?.personaModules || rawDecision?.personaModules,
      maxActivePersonaModules,
      source: hasRawDynamicPromptPlan ? 'planner' : 'rule',
      plannerProvided: hasRawDynamicPromptPlan
    }
  ), route, options);
  const cleanText = getPlannerRequestText(route);
  const rawRequestedToolNames = normalizeToolNames(
    Array.isArray(rawDecision?.allowedToolNames) ? rawDecision.allowedToolNames : []
  ).filter((toolName) => toolCatalogByName.has(toolName));
  const canonicalPreferredTools = choosePreferredToolSubset(route, available.allowedToolNames, toolCatalogByName, {
    allowPlannerCorrection: options.allowPlannerCorrection === true
  });
  const requestedAllowedNames = normalizeToolNames(
    Array.isArray(rawDecision?.allowedToolNames) ? rawDecision.allowedToolNames : fallback.allowedToolNames
  ).filter((toolName) => toolCatalogByName.has(toolName));
  let normalizedAllowedToolNames = requestedAllowedNames.length > 0 ? requestedAllowedNames : fallback.allowedToolNames;
  let toolGateReason = 'not_companion_mode';
  if (isCompanionPlannerMode(options)) {
    const candidateToolNames = normalizedAllowedToolNames.length > 0
      ? normalizedAllowedToolNames
      : rawRequestedToolNames;
    toolGateReason = candidateToolNames.length > 0
      ? resolveCompanionPlannerToolGateReason(route, candidateToolNames, options)
      : 'model_no_tool';
    normalizedAllowedToolNames = normalizedAllowedToolNames.filter((toolName) => (
      isCompanionPlannerToolUseAllowed(route, [toolName], options)
    ));
    if (!isCompanionPlannerToolUseAllowed(route, normalizedAllowedToolNames, options)) {
      normalizedAllowedToolNames = [];
    }
  }
  let taskShape = TASK_SHAPES.includes(normalizeText(rawDecision?.taskShape))
    ? normalizeText(rawDecision.taskShape)
    : fallback.taskShape;
  const rawSteps = normalizeArray(rawDecision?.steps);
  const acceptRawSteps = rawSteps.length > 0
    && rawSteps.every((step) => {
      const toolName = normalizeText(step?.tool);
      return toolName && normalizedAllowedToolNames.includes(toolName);
    });
  const steps = acceptRawSteps
    ? rawSteps.map((step, index) => buildExecutionStepGraph({
        tool: normalizeText(step?.tool),
        args: normalizeObject(step?.args, deriveToolArgs(normalizeText(step?.tool), route)),
        purpose: normalizeText(step?.purpose || step?.successCriteria),
        route,
        index,
        options: {
          id: normalizeText(step?.id) || `planner_step_${index + 1}`,
          kind: normalizeText(step?.kind) || (normalizeText(step?.kind) === 'context_evidence' ? 'context_evidence' : 'tool'),
          dependsOn: normalizeArray(step?.dependsOn),
          parallelGroup: normalizeText(step?.parallelGroup),
          sideEffect: Boolean(step?.sideEffect),
          successCriteria: normalizeText(step?.successCriteria),
          evidenceRequirement: normalizeObject(step?.evidenceRequirement, {}),
          repairPolicy: normalizeObject(step?.repairPolicy, {}),
          runtimeBinding: normalizeRuntimeBindingDescriptor(step, route),
          source: normalizeText(step?.source) || 'planner_v2'
        }
      }))
    : buildPlannerStepGraphSequence(route, normalizedAllowedToolNames, available.toolCatalog, {
        contextEvidence: Boolean(options.contextEvidence)
      });
  let normalizedByRule = false;
  let normalizationReason = '';
  const maybeApplyCanonicalNormalization = () => {
    if (canonicalPreferredTools.length === 0) return;
    const currentSet = new Set(normalizedAllowedToolNames);
    const canonicalSet = new Set(canonicalPreferredTools);
    const canonicalPrimary = normalizeText(canonicalPreferredTools[0]);
    const currentPrimary = normalizeText(normalizedAllowedToolNames[0]);
    const selectedGenericWebForSpecialized = currentSet.has('web_search')
      && canonicalPreferredTools.some((toolName) => toolName !== 'web_search' && toolName !== 'web_fetch');
    const notebookVsMemoryMismatch = (
      canonicalSet.has('notebook_search') && currentSet.has('memory_cli')
    ) || (
      canonicalSet.has('memory_cli') && (currentSet.has('notebook_search') || currentSet.has('notebook_list_docs'))
    );
    const arxivMismatch = canonicalPreferredTools.some((toolName) => /^skill_arxiv_/i.test(toolName))
      && currentSet.has('search_academic_paper');
    const financeMismatch = canonicalPreferredTools.some((toolName) => /^skill_stock_/i.test(toolName))
      && currentSet.has('web_search');
    const weatherMismatch = canonicalSet.has('skill_weather') && (currentSet.has('web_search') || currentSet.has('getWeather'));
    const contextMismatch = canonicalPrimary === 'get_context_stats' && currentPrimary !== canonicalPrimary;
    const timeMismatch = canonicalPrimary === 'get_current_time' && currentPrimary !== canonicalPrimary;
    const notebookMismatch = (canonicalPrimary === 'notebook_search' || canonicalPrimary === 'notebook_list_docs') && currentPrimary !== canonicalPrimary;
    const continuityMismatch = canonicalPrimary === 'memory_cli' && currentPrimary !== canonicalPrimary;
    const explicitUrlMismatch = canonicalPrimary === 'web_fetch' && currentPrimary !== canonicalPrimary;
    if (
      selectedGenericWebForSpecialized
      || notebookVsMemoryMismatch
      || arxivMismatch
      || financeMismatch
      || weatherMismatch
      || contextMismatch
      || timeMismatch
      || notebookMismatch
      || continuityMismatch
      || explicitUrlMismatch
    ) {
      normalizedAllowedToolNames = canonicalPreferredTools;
      normalizedByRule = true;
      normalizationReason = normalizedAllowedToolNames.join(', ');
      return true;
    }
    return false;
  };
  const canonicalApplied = maybeApplyCanonicalNormalization();
  if (
    normalizedAllowedToolNames.includes('memory_cli')
    && shouldPrioritizeMemoryProbe(route)
    && taskShape === 'fast_reply'
  ) {
    taskShape = 'tool_augmented_reply';
    normalizedByRule = true;
    normalizationReason = 'force memory recall tool plan';
  }
  if (isCompanionPlannerMode(options) && !isCompanionPlannerToolUseAllowed(route, normalizedAllowedToolNames, options)) {
    toolGateReason = normalizedAllowedToolNames.length > 0
      ? resolveCompanionPlannerToolGateReason(route, normalizedAllowedToolNames, options)
      : toolGateReason;
    normalizedAllowedToolNames = [];
    normalizedByRule = true;
    normalizationReason = 'companion tool mode: chat-only for non-companion tool intent';
  }
  if (isCompanionPlannerMode(options) && normalizedAllowedToolNames.length > 0) {
    toolGateReason = resolveCompanionPlannerToolGateReason(route, normalizedAllowedToolNames, options);
  }
  const rebuiltSteps = canonicalApplied
    ? buildPlannerStepGraphSequence(route, normalizedAllowedToolNames, available.toolCatalog, {
        contextEvidence: Boolean(options.contextEvidence)
      })
    : steps;
  const enforcedSteps = (() => {
    if (normalizedAllowedToolNames.length === 1 && normalizedAllowedToolNames[0] === 'memory_cli') {
      return buildPlannerStepGraphSequence(route, ['memory_cli'], available.toolCatalog, {
        contextEvidence: Boolean(options.contextEvidence)
      });
    }
    if (shouldForceWebSearchFetchPlan(route, { allowedToolNames: normalizedAllowedToolNames })) {
      return buildPlannerStepGraphSequence(route, ['web_search', 'web_fetch'], available.toolCatalog, {
        contextEvidence: Boolean(options.contextEvidence)
      });
    }
    return rebuiltSteps;
  })();
  const subjectiveOpinion = isSubjectiveOpinionQuestion(route);
  const conversationalNoop = isConversationalNoop(cleanText) || subjectiveOpinion;
  const normalizedSteps = (conversationalNoop || taskShape === 'fast_reply') ? [] : enforcedSteps;
  const mode = normalizedSteps.length > 0 ? 'tool_plan' : 'chat_only';
  return {
    mode,
    taskShape: normalizedSteps.length > 0 ? taskShape : 'fast_reply',
    allowedToolNames: normalizedSteps.length > 0 ? normalizedAllowedToolNames : [],
    steps: normalizedSteps,
    personaModules: normalizedDynamicPromptPlan.personaModules,
    dynamicPromptPlan: normalizedDynamicPromptPlan,
    validation: buildValidationEnvelope({
      mode,
      taskShape: normalizedSteps.length > 0 ? taskShape : 'fast_reply',
      steps: normalizedSteps,
      goal: normalizeText(options.goal || route?.question || route?.cleanText),
      plannerMeta: normalizeObject(rawDecision?.plannerMeta, {})
    }),
    plannerMeta: {
      protocolVersion: PLANNER_PROTOCOL_VERSION,
      decisionVersion: normalizeText(rawDecision?.plannerMeta?.decisionVersion) || getPlannerDecisionVersion(),
      plannerVersion: normalizeText(rawDecision?.plannerMeta?.plannerVersion) || DIRECT_CHAT_PLANNER_VERSION,
      reason: normalizePlannerReasonText(normalizeText(rawDecision?.plannerMeta?.reason) || fallback?.plannerMeta?.reason || '', {
        normalizedByRule,
        normalizationReason
      }),
      plannerModel: normalizeText(rawDecision?.plannerMeta?.plannerModel || getPlannerModel()) || getPlannerModel(),
      fallbackUsed: Boolean(options.fallbackUsed),
      decisionSource: normalizeText(rawDecision?.plannerMeta?.decisionSource) || (options.fallbackUsed ? 'rule' : 'planner'),
      toolGateReason: normalizeText(rawDecision?.plannerMeta?.toolGateReason) || toolGateReason,
      latencyMeta: normalizePlannerLatencyMeta(
        rawDecision?.plannerMeta?.latencyMeta,
        options.latencyMeta
      ),
      toolBuckets: Array.from(new Set(
        normalizeToolNames(normalizedSteps.map((step) => step.tool)).map((toolName) => resolveToolBucket(toolName, toolCatalogByName))
      )),
      personaModules: normalizedDynamicPromptPlan.personaModules,
      dynamicPromptPlan: normalizedDynamicPromptPlan,
      personaModuleReason: normalizeText(
        rawDecision?.plannerMeta?.personaModuleReason
        || rawDecision?.personaModuleReason
      ),
      normalizedByRule,
      normalizationReason: normalizeText(normalizationReason),
      semanticConfidence: clampNumber(
        rawDecision?.plannerMeta?.semanticConfidence
          ?? rawDecision?.plannerMeta?.semanticAssessment?.confidence
          ?? rawDecision?.semanticConfidence,
        0,
        1,
        null
      ),
      needsSemanticRefinement: rawDecision?.plannerMeta?.needsSemanticRefinement === true
        || rawDecision?.plannerMeta?.semanticAssessment?.needsRefinement === true
        || rawDecision?.needsSemanticRefinement === true,
      semanticAssessment: normalizeObject(
        rawDecision?.plannerMeta?.semanticAssessment
          || rawDecision?.semanticAssessment,
        {}
      ),
      semanticRefinement: normalizeObject(options.plannerModelAttemptMeta, {}),
      ...buildBackgroundResearchMeta(route, options)
    }
  };
}

module.exports = {
  buildPlannerPrompt,
  buildPlannerUserPayload,
  normalizePlannerDecisionV2,
  normalizeRuntimeBindingDescriptor
};


const {
  DIRECT_CHAT_PLANNER_VERSION,
  PLANNER_PROTOCOL_VERSION,
  TOOL_BUCKETS,
  buildHeuristicDynamicPromptPlan,
  chooseTaskShape,
  clampReason,
  getMainReplyDynamicBlockCatalog,
  getPlannerRequestText,
  getPersonaModuleCatalogSummary,
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
  prefersMemoryRecall,
  shouldPrioritizeMemoryProbe
} = require('./runtime-core.chunk');
const {
  buildToolCatalogByName,
  buildValidationEnvelope,
  getPlannerDecisionVersion,
  isWriteCapableTool,
  normalizeDynamicPromptPlan,
  resolveToolBucket
} = require('./dynamic-plan.chunk');
const {
  collectAvailableToolSummary,
  getPlannerModel,
  isCompanionPlannerMode,
  isCompanionPlannerToolUseAllowed,
  resolveCompanionPlannerToolGateReason,
  buildBackgroundResearchMeta
} = require('./tool-gating.chunk');
const {
  buildPlannerStepGraphSequence,
  pickMinimalToolAllowlist,
  requiresToolEvidence,
  shouldPrioritizeContextStats
} = require('./tool-selection.chunk');

const DYNAMIC_PROMPT_BLOCK_SIGNAL_KEYS = Object.freeze({
  roleplay_runtime_context: 'roleplayRuntimeContext',
  affinity_level: 'affinityState',
  affinity_points: 'affinityState',
  persona_memory: 'personaMemory',
  long_term_profile: 'longTermProfile',
  impression: 'impression',
  relationship_state: 'relationship',
  summary: 'summary',
  retrieved_memory_lite: 'retrievedMemory',
  memos_recall: 'memosRecall',
  daily_journal: 'dailyJournal',
  short_term_continuity: 'shortTermContinuity',
  continuity_state: 'continuity',
  directed_context: 'directedContext',
  style_profile: 'styleProfile',
  social_context: 'socialContext',
  self_improvement: 'selfImprovement',
  dynamic_few_shot: 'dynamicFewShot',
  memory_cli_instruction: 'memoryCliInstruction',
  context_stats_instruction: 'contextStatsInstruction',
  life_scheduler: 'schedulerInjection'
});

const DYNAMIC_PROMPT_BLOCK_SELECTION_POLICIES = Object.freeze({
  roleplay_runtime_context: 'must_use_when_available',
  affinity_level: 'include_if_relevant',
  affinity_points: 'include_if_relevant',
  persona_memory: 'include_if_relevant',
  long_term_profile: 'include_if_relevant',
  impression: 'include_if_relevant',
  relationship_state: 'include_if_relevant',
  summary: 'include_if_relevant',
  retrieved_memory_lite: 'high_value_only',
  memos_recall: 'high_value_only',
  daily_journal: 'high_value_only',
  short_term_continuity: 'must_use_when_available',
  continuity_state: 'include_if_relevant',
  directed_context: 'must_use_when_available',
  style_profile: 'include_if_relevant',
  social_context: 'include_if_relevant',
  self_improvement: 'include_if_relevant',
  dynamic_few_shot: 'high_value_only',
  memory_cli_instruction: 'tool_policy_only',
  context_stats_instruction: 'tool_policy_only',
  life_scheduler: 'include_if_relevant'
});

function getDynamicPromptBlockSignalKey(blockId = '') {
  const normalized = normalizeText(blockId);
  if (!normalized || normalized.startsWith('persona_module:')) return '';
  return DYNAMIC_PROMPT_BLOCK_SIGNAL_KEYS[normalized] || '';
}

function getDynamicPromptBlockSelectionPolicy(blockId = '') {
  const normalized = normalizeText(blockId);
  if (!normalized) return 'situational';
  if (normalized.startsWith('persona_module:')) return 'planner_selected';
  return DYNAMIC_PROMPT_BLOCK_SELECTION_POLICIES[normalized] || 'situational';
}

function isDynamicPromptBlockAvailable(blockId = '', availableContextSignals = {}) {
  const signalKey = getDynamicPromptBlockSignalKey(blockId);
  if (!signalKey) return true;
  const signals = normalizeObject(availableContextSignals, {});
  if (!Object.prototype.hasOwnProperty.call(signals, signalKey)) return false;
  return signals[signalKey] === true;
}

function buildRuleBasedPlannerDecision(route = {}, options = {}) {
  const chatMode = normalizeChatMode(route?.meta?.chatMode);
  const toolIntent = normalizeToolIntent(route?.meta?.toolIntent);
  const responseIntent = normalizeResponseIntent(route?.meta?.responseIntent);
  const cleanText = getPlannerRequestText(route);
  const available = collectAvailableToolSummary(route, options);
  const toolCatalogByName = buildToolCatalogByName(available.toolCatalog);
  const ruleTaskShape = chooseTaskShape(route);
  const domain = normalizeText(route?.facets?.domain);
  const goal = normalizeText(options.goal || cleanText || route?.question);
  const decisionSource = normalizeText(options.decisionSource) || 'rule';
  const fallbackUsed = Object.prototype.hasOwnProperty.call(options, 'fallbackUsed')
    ? Boolean(options.fallbackUsed)
    : true;
  const personaModuleCatalog = normalizeArray(options.personaModuleCatalog).length > 0
    ? normalizeArray(options.personaModuleCatalog)
    : getPersonaModuleCatalogSummary();
  const dynamicPromptBlockCatalog = normalizeArray(options.dynamicPromptBlockCatalog).length > 0
    ? normalizeArray(options.dynamicPromptBlockCatalog)
    : getMainReplyDynamicBlockCatalog(personaModuleCatalog);
  const availableContextSignals = buildAvailableContextSignals(route, options);
  const heuristicDynamicPromptPlan = buildHeuristicDynamicPromptPlan({
    continuitySignals: options.continuitySignals,
    directedContext: options.directedContext,
    hasRoleplayRuntimeContext: availableContextSignals.roleplayRuntimeContext,
    hasAffinityState: availableContextSignals.affinityState,
    hasShortTermContinuity: availableContextSignals.shortTermContinuity,
    hasRetrievedMemory: availableContextSignals.retrievedMemory,
    hasMemosRecall: availableContextSignals.memosRecall,
    hasDailyJournal: availableContextSignals.dailyJournal,
    hasLongTermProfile: availableContextSignals.longTermProfile,
    hasImpression: availableContextSignals.impression,
    hasRelationshipState: availableContextSignals.relationship,
    hasStyleProfile: availableContextSignals.styleProfile,
    hasSocialContext: availableContextSignals.socialContext,
    hasSelfImprovement: availableContextSignals.selfImprovement,
    hasDynamicFewShot: availableContextSignals.dynamicFewShot,
    hasMemoryCliInstruction: availableContextSignals.memoryCliInstruction,
    hasContextStatsInstruction: availableContextSignals.contextStatsInstruction,
    hasLifeScheduler: availableContextSignals.schedulerInjection
  });

  if (isConversationalNoop(cleanText)) {
    const dynamicPromptPlan = normalizeDynamicPromptPlan(heuristicDynamicPromptPlan, {
      personaModuleCatalog,
      dynamicPromptBlockCatalog,
      source: 'rule',
      plannerProvided: false
    });
    return {
      mode: 'chat_only',
      taskShape: 'fast_reply',
      allowedToolNames: [],
      steps: [],
      personaModules: dynamicPromptPlan.personaModules,
      dynamicPromptPlan,
      validation: buildValidationEnvelope({
        mode: 'chat_only',
        taskShape: 'fast_reply',
        steps: [],
        goal,
        plannerMeta: { fallbackUsed, decisionSource }
      }),
      plannerMeta: {
        protocolVersion: PLANNER_PROTOCOL_VERSION,
        decisionVersion: getPlannerDecisionVersion(),
        plannerVersion: DIRECT_CHAT_PLANNER_VERSION,
        reason: clampReason(`chatMode=${chatMode}; responseIntent=${responseIntent}; toolIntent=${toolIntent}; conversational noop; answer without tools`),
        plannerModel: getPlannerModel(),
        fallbackUsed,
        decisionSource,
        toolGateReason: resolveCompanionPlannerToolGateReason(route, [], options),
        latencyMeta: normalizePlannerLatencyMeta(options.latencyMeta),
        toolBuckets: [],
        personaModules: dynamicPromptPlan.personaModules,
        dynamicPromptPlan,
        ...buildBackgroundResearchMeta(route, options)
      }
    };
  }

  let shouldUseTools = false;
  if (toolIntent === 'force_tools') shouldUseTools = available.allowedToolNames.length > 0;
  else if (toolIntent === 'maybe_tools') {
    shouldUseTools = requiresToolEvidence(route);
    if (!shouldUseTools && responseIntent === 'plan') {
      shouldUseTools = available.allowedToolNames.some((toolName) => /^research_|^study_|^assistant_/.test(toolName));
    }
    if (!shouldUseTools && responseIntent === 'action_guidance') {
      shouldUseTools = available.allowedToolNames.some((toolName) => /(schedule|calendar|agenda|todo|task|email|decision|pomodoro)/i.test(toolName));
    }
    if (!shouldUseTools && chatMode === 'image_summary') {
      shouldUseTools = available.allowedToolNames.some((toolName) => /summarize|extract|context_stats/i.test(toolName));
    }
  }
  if (shouldUseTools && isCompanionPlannerMode(options)) {
    const companionGateToolNames = pickMinimalToolAllowlist(route, available);
    shouldUseTools = isCompanionPlannerToolUseAllowed(
      route,
      companionGateToolNames.length > 0 ? companionGateToolNames : available.allowedToolNames,
      options
    );
  }

  let allowedToolNames = [];
  if (domain === 'time') {
    allowedToolNames = pickMinimalToolAllowlist(route, available);
    shouldUseTools = allowedToolNames.length > 0;
  } else if (chatMode === 'image_qa' || chatMode === 'image_summary') {
    shouldUseTools = toolIntent === 'force_tools' ? available.allowedToolNames.length > 0 : false;
  }

  if (shouldUseTools && allowedToolNames.length === 0 && (responseIntent === 'plan' || responseIntent === 'action_guidance')) {
    allowedToolNames = pickMinimalToolAllowlist(route, available);
  }

  if (shouldUseTools && allowedToolNames.length === 0 && shouldPrioritizeContextStats(route, available.allowedToolNames)) {
    allowedToolNames = pickMinimalToolAllowlist(route, available);
  }

  if (shouldUseTools && allowedToolNames.length === 0 && shouldPrioritizeMemoryProbe(route) && available.allowedToolNames.includes('memory_cli')) {
    allowedToolNames = ['memory_cli'];
  }

  if (!shouldPrioritizeContextStats(route, available.allowedToolNames)
    && shouldUseTools
    && allowedToolNames.length === 0
    && prefersMemoryRecall(cleanText)
    && available.allowedToolNames.includes('memory_cli')) {
    allowedToolNames = ['memory_cli'];
  }

  if ((toolIntent === 'maybe_tools' || toolIntent === 'force_tools') && shouldUseTools && allowedToolNames.length === 0) {
    allowedToolNames = pickMinimalToolAllowlist(route, available);
  }

  if (allowedToolNames.length === 0 && shouldUseTools) {
    const selectedToolNames = normalizeToolNames(
      available.allowedToolNames.filter((toolName) => !isWriteCapableTool(toolCatalogByName, toolName))
    );
    const writeToolNames = normalizeToolNames(
      available.allowedToolNames.filter((toolName) => isWriteCapableTool(toolCatalogByName, toolName))
    );
    allowedToolNames = writeToolNames.length > 0 ? writeToolNames : selectedToolNames;
  }

  const normalizedAllowedToolNames = normalizeToolNames(allowedToolNames)
    .filter((toolName) => toolCatalogByName.has(toolName))
    .filter((toolName) => !isCompanionPlannerMode(options) || isCompanionPlannerToolUseAllowed(route, [toolName], options));
  const toolGateReason = isCompanionPlannerMode(options)
    ? resolveCompanionPlannerToolGateReason(route, normalizedAllowedToolNames.length > 0 ? normalizedAllowedToolNames : allowedToolNames, options)
    : 'not_companion_mode';
  const writeToolNames = normalizedAllowedToolNames.filter((toolName) => isWriteCapableTool(toolCatalogByName, toolName));
  const taskShape = normalizedAllowedToolNames.length === 0
    ? 'fast_reply'
    : (writeToolNames.length > 0 || ruleTaskShape === 'background_tool_task')
      ? 'background_tool_task'
      : 'tool_augmented_reply';
  const steps = buildPlannerStepGraphSequence(route, normalizedAllowedToolNames, available.toolCatalog, {
    contextEvidence: false
  });
  const toolBuckets = Array.from(new Set(
    normalizedAllowedToolNames.map((toolName) => resolveToolBucket(toolName, toolCatalogByName)).filter((bucket) => TOOL_BUCKETS.includes(bucket))
  ));
  const mode = normalizedAllowedToolNames.length > 0 ? 'tool_plan' : 'chat_only';
  const reasonParts = [
    `chatMode=${chatMode}`,
    `responseIntent=${responseIntent}`,
    `toolIntent=${toolIntent}`
  ];
  if (cleanText) reasonParts.push(`request=${cleanText.slice(0, 80)}`);
  const dynamicPromptPlan = normalizeDynamicPromptPlan(heuristicDynamicPromptPlan, {
    personaModuleCatalog,
    dynamicPromptBlockCatalog,
    source: 'rule',
    plannerProvided: false
  });

  return {
    mode,
    taskShape,
    allowedToolNames: normalizedAllowedToolNames,
    steps,
    personaModules: dynamicPromptPlan.personaModules,
    dynamicPromptPlan,
    validation: buildValidationEnvelope({
      mode,
      taskShape,
      steps,
      goal,
      plannerMeta: { fallbackUsed, decisionSource, toolGateReason }
    }),
    plannerMeta: {
      protocolVersion: PLANNER_PROTOCOL_VERSION,
      decisionVersion: getPlannerDecisionVersion(),
      plannerVersion: DIRECT_CHAT_PLANNER_VERSION,
      reason: clampReason(
        domain === 'time' && normalizedAllowedToolNames.length > 0
          ? 'domain=time; require get_current_time evidence'
          : reasonParts.join('; ')
      ),
      plannerModel: getPlannerModel(),
      fallbackUsed,
      decisionSource,
      toolGateReason,
      latencyMeta: normalizePlannerLatencyMeta(options.latencyMeta),
      toolBuckets,
      personaModules: dynamicPromptPlan.personaModules,
      dynamicPromptPlan,
      ...buildBackgroundResearchMeta(route, options)
    }
  };
}

function summarizeToolCatalogForPrompt(toolCatalog = []) {
  const buckets = new Map();
  for (const item of normalizeArray(toolCatalog)) {
    const bucket = normalizeText(item?.bucket);
    const name = normalizeText(item?.name);
    if (!bucket || !name) continue;
    const description = clampReason(normalizeText(item?.description) || name, 140);
    const access = item?.writeCapable ? 'write' : 'read';
    const plannerRole = normalizeText(item?.plannerRole);
    const overlapGroup = normalizeText(item?.overlapGroup);
    const preferredOver = normalizeArray(item?.preferredOver).map((entry) => normalizeText(entry)).filter(Boolean).join(', ');
    const preferWhen = normalizeArray(item?.preferWhen).map((entry) => normalizeText(entry)).filter(Boolean).join('; ');
    const avoidWhen = normalizeArray(item?.avoidWhen).map((entry) => normalizeText(entry)).filter(Boolean).join('; ');
    const annotations = [
      plannerRole ? `role=${plannerRole}` : '',
      overlapGroup ? `group=${overlapGroup}` : '',
      preferredOver ? `preferred_over=${preferredOver}` : '',
      preferWhen ? `prefer_when=${preferWhen}` : '',
      avoidWhen ? `avoid_when=${avoidWhen}` : ''
    ].filter(Boolean).join(' | ');
    const line = annotations
      ? `- ${name}: ${description} [${access}] | ${annotations}`
      : `- ${name}: ${description} [${access}]`;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(line);
  }
  const orderedBuckets = TOOL_BUCKETS.filter((bucket) => buckets.has(bucket));
  if (orderedBuckets.length === 0) return 'No tools available.';
  return orderedBuckets.map((bucket) => {
    const usageHint = {
      local_tools: 'Prefer for deterministic local transforms, calculators, schedulers, notebook operations, and structured generators.',
      global_tools: 'Prefer for web search, memory recall, and current time when factual evidence or continuity is needed.',
      skills: 'Prefer for richer specialized workflows such as web research, arXiv, weather, transcripts, summaries, finance, or domain guides.',
      mcp: 'Prefer when an MCP-backed connector is the most direct source of live external data or capability.'
    }[bucket] || 'Use when appropriate.';
    return [`[${bucket}] ${usageHint}`, ...buckets.get(bucket)].join('\n');
  }).join('\n');
}

function sanitizePlannerContextSummary(summary = '', maxLength = 360) {
  const text = String(summary || '')
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\b(?:group|groupId|user|userId|session|sessionId)\s*[:=]\s*[A-Za-z0-9:_-]+\b/gi, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function hasMeaningfulText(value) {
  return normalizeText(value) && !/^(?:none|null|undefined|暂无|无)$/i.test(normalizeText(value));
}

function hasMeaningfulObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).some((entry) => {
    if (entry && typeof entry === 'object') return hasMeaningfulObject(entry);
    return hasMeaningfulText(entry) || entry === true || (Number.isFinite(Number(entry)) && Number(entry) !== 0);
  });
}

function buildAvailableContextSignals(route = {}, options = {}) {
  const routeMeta = normalizeObject(route?.meta, {});
  const memoryContext = normalizeObject(options.memoryContext, {});
  const directedContext = normalizeObject(options.directedContext || routeMeta.directedContext, null);
  const continuitySignals = normalizeObject(options.continuitySignals || routeMeta.continuitySignals, {});
  const sharedShortTermContext = normalizeObject(options.sharedShortTermContext || routeMeta.sharedShortTermContext, {});
  const explicitSignals = normalizeObject(options.availableContextSignals, {});
  const signal = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(explicitSignals, key)
      ? explicitSignals[key] === true
      : Boolean(fallback)
  );
  return {
    roleplayRuntimeContext: signal('roleplayRuntimeContext', true),
    affinityState: signal('affinityState', (
      hasMeaningfulObject(memoryContext.affinityState)
      || hasMeaningfulText(options?.userInfo?.level)
      || Number.isFinite(Number(options?.userInfo?.points))
    )),
    personaMemory: signal('personaMemory', (
      hasMeaningfulObject(options.personaMemoryState)
      || hasMeaningfulObject(memoryContext.persona)
    )),
    shortTermContinuity: signal('shortTermContinuity', (
      hasMeaningfulText(sharedShortTermContext.shortTermSummary)
      || normalizeArray(sharedShortTermContext.recentHistory).length > 0
      || normalizeArray(sharedShortTermContext.recentSessionSummaries).length > 0
    )),
    directedContext: signal('directedContext', directedContext && (
      hasMeaningfulText(directedContext.scene)
      || hasMeaningfulObject(directedContext.addressee)
      || hasMeaningfulObject(directedContext.quote)
      || hasMeaningfulObject(directedContext.quotePriority)
    )),
    continuity: signal('continuity', hasMeaningfulObject(continuitySignals)),
    retrievedMemory: signal('retrievedMemory', (
      hasMeaningfulText(memoryContext.promptRetrievedMemoryText)
      || hasMeaningfulText(memoryContext.memoryForPrompt)
      || hasMeaningfulText(options.retrievedMemoryText)
    )),
    memosRecall: signal('memosRecall', (
      hasMeaningfulText(options.memosRecallText)
      || hasMeaningfulText(options.memosRecall?.promptText)
      || normalizeArray(options.memosRecall?.items).some((item) => hasMeaningfulText(item?.text || item?.content))
    )),
    dailyJournal: signal('dailyJournal', (
      hasMeaningfulText(memoryContext.promptDailyJournalText)
      || hasMeaningfulText(memoryContext.dailyJournalText)
    )),
    longTermProfile: signal('longTermProfile', (
      hasMeaningfulText(memoryContext.promptLongTermProfileText)
      || hasMeaningfulText(memoryContext.longTermProfileText)
      || hasMeaningfulText(memoryContext.profileText)
    )),
    impression: signal('impression', (
      hasMeaningfulText(memoryContext.promptImpressionText)
      || hasMeaningfulText(memoryContext.impressionText)
    )),
    relationship: signal('relationship', (
      hasMeaningfulObject(memoryContext.relationshipState)
      || hasMeaningfulObject(memoryContext.affinityState)
      || hasMeaningfulText(memoryContext?.profile?.relation_stage)
      || hasMeaningfulText(options?.userInfo?.level)
    )),
    summary: signal('summary', (
      hasMeaningfulText(options.contextSummary)
      || hasMeaningfulText(routeMeta.sessionContextSummary)
      || hasMeaningfulText(routeMeta.contextSummary)
      || hasMeaningfulText(routeMeta.conversationSummary)
      || hasMeaningfulText(memoryContext.promptSummaryText)
      || hasMeaningfulText(memoryContext.summary)
    )),
    styleProfile: signal('styleProfile', (
      hasMeaningfulText(options.styleProfileSnippet)
      || hasMeaningfulText(routeMeta.styleProfile)
      || hasMeaningfulObject(routeMeta.styleProfile)
    )),
    socialContext: signal('socialContext', (
      hasMeaningfulText(options.socialContextSnippet)
      || hasMeaningfulObject(routeMeta.socialContext)
      || hasMeaningfulText(routeMeta.groupId || routeMeta.group_id)
    )),
    dynamicFewShot: signal('dynamicFewShot', hasMeaningfulText(options.dynamicFewShotPrompt)),
    memoryCliInstruction: signal('memoryCliInstruction', (
      hasMeaningfulObject(options.memoryCliTurn)
      || normalizeArray(options.allowedTools || routeMeta.allowedTools).includes('memory_cli')
    )),
    contextStatsInstruction: signal('contextStatsInstruction', (
      normalizeArray(options.allowedTools || routeMeta.allowedTools).includes('get_context_stats')
    )),
    schedulerInjection: signal('schedulerInjection', (
      hasMeaningfulText(options.schedulerInjection)
      || hasMeaningfulObject(routeMeta.schedulerInjection)
      || hasMeaningfulObject(routeMeta.lifeSchedulerInjection)
    ))
  };
}

function normalizeDynamicPromptBlockCatalogForPlanner(blockCatalog = [], availableContextSignals = {}) {
  return normalizeArray(blockCatalog)
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const blockId = normalizeText(item.blockId);
      const signalKey = getDynamicPromptBlockSignalKey(blockId);
      const selectionPolicy = getDynamicPromptBlockSelectionPolicy(blockId);
      return {
        ...item,
        blockId,
        lane: normalizeText(item.lane || item.cacheLane || 'dynamic_context'),
        category: normalizeText(item.category || 'general'),
        defaultPolicy: normalizeText(item.defaultPolicy || 'situational'),
        selectionPolicy,
        signalKey,
        available: isDynamicPromptBlockAvailable(blockId, availableContextSignals),
        useWhen: normalizeText(item.useWhen || item.purpose || ''),
        avoidWhen: normalizeText(item.avoidWhen || '')
      };
    })
    .filter((item) => item.blockId);
}

module.exports = {
  buildAvailableContextSignals,
  buildRuleBasedPlannerDecision,
  getDynamicPromptBlockSelectionPolicy,
  getDynamicPromptBlockSignalKey,
  hasMeaningfulObject,
  hasMeaningfulText,
  isDynamicPromptBlockAvailable,
  normalizeDynamicPromptBlockCatalogForPlanner,
  sanitizePlannerContextSummary,
  summarizeToolCatalogForPrompt
};


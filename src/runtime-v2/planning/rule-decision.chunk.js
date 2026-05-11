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
  const heuristicDynamicPromptPlan = buildHeuristicDynamicPromptPlan({
    continuitySignals: options.continuitySignals,
    directedContext: options.directedContext,
    hasContextStatsInstruction: true
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
  const explicitSignals = normalizeObject(options.availableContextSignals, {});
  const signal = (key, fallback) => (
    Object.prototype.hasOwnProperty.call(explicitSignals, key)
      ? explicitSignals[key] === true
      : Boolean(fallback)
  );
  return {
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
    schedulerInjection: signal('schedulerInjection', (
      hasMeaningfulText(options.schedulerInjection)
      || hasMeaningfulObject(routeMeta.schedulerInjection)
      || hasMeaningfulObject(routeMeta.lifeSchedulerInjection)
    ))
  };
}

function normalizeDynamicPromptBlockCatalogForPlanner(blockCatalog = []) {
  return normalizeArray(blockCatalog)
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      ...item,
      blockId: normalizeText(item.blockId),
      lane: normalizeText(item.lane || item.cacheLane || 'dynamic_context'),
      category: normalizeText(item.category || 'general'),
      defaultPolicy: normalizeText(item.defaultPolicy || 'situational'),
      useWhen: normalizeText(item.useWhen || item.purpose || ''),
      avoidWhen: normalizeText(item.avoidWhen || '')
    }))
    .filter((item) => item.blockId);
}


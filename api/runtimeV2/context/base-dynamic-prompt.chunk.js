async function buildBaseDynamicPrompt(userInfo, userId, question, customPrompt = null, options = {}) {
  const promptMaterials = options.promptMaterials && typeof options.promptMaterials === 'object'
    ? options.promptMaterials
    : null;
  const affinity = promptMaterials?.affinity && typeof promptMaterials.affinity === 'object'
    ? promptMaterials.affinity
    : getAffinitySettings(userInfo, { userId });
  const routeMeta = options.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const dynamicPromptPlan = promptMaterials?.dynamicPromptPlan && typeof promptMaterials.dynamicPromptPlan === 'object'
    ? promptMaterials.dynamicPromptPlan
    : normalizeDynamicPromptPlan(options);
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  const includeOptionalContextBlocks = options.includeOptionalContextBlocks !== false;
  const includePersonaModuleBlocks = options.includePersonaModuleBlocks !== false;
  const includeDynamicFewShotBlock = options.includeDynamicFewShotBlock !== false;
  const sharedShortTermContext = promptMaterials?.sharedShortTermContext && typeof promptMaterials.sharedShortTermContext === 'object'
    ? promptMaterials.sharedShortTermContext
    : (options.sharedShortTermContext && typeof options.sharedShortTermContext === 'object'
      ? options.sharedShortTermContext
      : buildSharedShortTermContextMessages(userId, userInfo, {
        chatHistory: options.chatHistory,
        shortTermMemory: options.shortTermMemory,
        routeMeta,
        sessionKey: options.sessionKey
      }));
  const memoryContext = promptMaterials?.memoryContext && typeof promptMaterials.memoryContext === 'object'
    ? promptMaterials.memoryContext
    : await buildMemoryContextAsync(userId, question || '', {
      routePolicyKey,
      topRouteType,
      groupId: routeMeta.groupId || routeMeta.group_id || '',
      sessionKey: options.sessionKey || routeMeta.sessionKey || routeMeta.session_key || '',
      sessionId: routeMeta.sessionId || routeMeta.session_id || '',
      taskType: routeMeta.taskType || routeMeta.task_type || '',
      agentName: routeMeta.agentName || routeMeta.agent_name || '',
      toolName: routeMeta.toolName || routeMeta.tool_name || '',
      journalToday: options.journalToday,
      journalNow: options.journalNow,
      dailyJournalTimestamp: options.dailyJournalTimestamp,
      dailyJournalYearMonth: options.dailyJournalYearMonth,
      dailyJournalMaxFourDayFiles: options.dailyJournalMaxFourDayFiles,
      dailyJournalMaxMonthlyFiles: options.dailyJournalMaxMonthlyFiles,
      dailyLookbackDays: options.dailyLookbackDays,
      lookbackDays: options.lookbackDays,
      sharedShortTermSignature: sharedShortTermContext.sharedShortTermSignature,
      __memoryContextMemo: options.__memoryContextMemo
    });
  const forceMemoryContext = shouldForceMemoryContextForQuestion(question, {
    ...options,
    routeMeta
  });
  const personaMemoryState = promptMaterials?.personaMemoryState && typeof promptMaterials.personaMemoryState === 'object'
    ? promptMaterials.personaMemoryState
    : await composePersonaMemoryState({
      userId,
      question: question || '',
      routeMeta,
      routePolicyKey,
      topRouteType
    }, {
      userInfo,
      surface: promptMaterials?.surface || buildPromptSurface(topRouteType, routeMeta),
      sessionKey: options.sessionKey,
      shortTermMemory: options.shortTermMemory,
      chatHistory: options.chatHistory,
      personaModules: dynamicPromptPlan.personaModules,
      sharedShortTermContext,
      memoryContext
    });
  const personaMemoryPrompt = promptMaterials?.personaMemoryPrompt && typeof promptMaterials.personaMemoryPrompt === 'object'
    ? promptMaterials.personaMemoryPrompt
    : renderPersonaMemoryPrompt(
      personaMemoryState,
      topRouteType === 'proactive' ? 'proactive_touch' : 'direct_chat'
    );
  const shouldResolvePersonaModules = options.resolvePersonaModules !== false;
  const personaModuleCandidates = shouldResolvePersonaModules
    ? (promptMaterials?.personaModuleCandidates || buildPersonaModuleCandidates({
      question,
      routePrompt: options.routePrompt,
      routeMeta,
      directedContext: routeMeta.directedContext,
      continuitySignals: options?.continuitySignals,
      personaPhase: routeMeta.personaPhase || '',
      chatType: getRouteMetaGroupId(routeMeta) ? 'group' : String(routeMeta.chatType || routeMeta.chat_type || '').trim(),
      maxPersonaModuleCandidates: options.maxPersonaModuleCandidates
    }))
    : [];
  const personaWorldbookSearch = promptMaterials?.personaWorldbookSearch && typeof promptMaterials.personaWorldbookSearch === 'object'
    ? promptMaterials.personaWorldbookSearch
    : {};
  const personaModuleDecision = shouldResolvePersonaModules
    ? (promptMaterials?.personaModuleDecision || selectPersonaModules(
      {
        ...(options?.personaModuleDecision || routeMeta?.directChatPlanner || routeMeta?.toolPlanner || {}),
        personaModules: dynamicPromptPlan.personaModules.length > 0
          ? dynamicPromptPlan.personaModules
          : normalizeArray(options?.personaModuleDecision?.personaModules || routeMeta?.directChatPlanner?.personaModules || routeMeta?.toolPlanner?.personaModules)
      },
      {
        question,
        routePrompt: options.routePrompt,
        routeMeta,
        directedContext: routeMeta.directedContext,
        continuitySignals: options?.continuitySignals,
        personaPhase: routeMeta.personaPhase || '',
        chatType: getRouteMetaGroupId(routeMeta) ? 'group' : String(routeMeta.chatType || routeMeta.chat_type || '').trim(),
        maxPersonaModuleCandidates: options.maxPersonaModuleCandidates,
        personaModuleCandidates
      }
    ))
    : { selected: [], rejected: [] };
  const promptBlocks = [];
  const promptSegments = {
    systemPrompt: [],
    routePrompt: options.routePrompt ? [{ role: 'system', content: String(options.routePrompt || '').trim() }] : [],
    memoryContext: memoryContext?.segments || {},
    personaMemory: personaMemoryPrompt.systemMessages || [],
    assembledBlocks: [],
    renderedSystemMessages: [],
    tokenUsageByBlock: [],
    trimDecisions: [],
    securityLabels: [],
    activatedPersonaModules: [],
    personaModuleCandidates: [],
    personaModuleTokenUsage: []
  };

  if (customPrompt) {
    const reviewMode = String(options?.reviewMode || '').trim().toLowerCase();
    const topRoute = String(topRouteType || '').trim().toLowerCase();
    const customStage = reviewMode ? 'review' : (topRoute === 'plan' ? 'planner' : 'main');
    const customPromptBlock = createPromptBlock('custom_prompt', 'Custom Prompt', customPrompt, {
      stage: customStage,
      priority: 10,
      authority: 'custom_prompt',
      kind: 'custom_prompt',
      source: 'custom'
    });
    const customSnapshot = buildPromptSnapshot(customPromptBlock ? [customPromptBlock] : [], {
      stage: customStage,
      policyKey: String(options?.routePolicyKey || '').trim() || customStage
    });
    return {
      dynamicPrompt: customSnapshot.renderedSystemMessages.map((message) => String(message.content || '').trim()).filter(Boolean).join('\n\n'),
      stableSystemBlocks: customSnapshot.assembledBlocks,
      dynamicContextBlocks: [],
      assistantOnlyContextBlocks: [],
      promptSegments: {
        ...promptSegments,
        systemPrompt: customSnapshot.renderedSystemMessages,
        assembledBlocks: customSnapshot.assembledBlocks,
        renderedSystemMessages: customSnapshot.renderedSystemMessages,
        tokenUsageByBlock: customSnapshot.tokenUsageByBlock,
        trimDecisions: customSnapshot.trimDecisions
      },
      promptSnapshot: customSnapshot,
      memoryContext,
      personaMemoryState,
      affinity,
      dynamicPromptPlan
    };
  }
  const stablePromptBlocks = normalizeArray(options.cachedStableSystemBlocks).length > 0
    ? normalizeArray(options.cachedStableSystemBlocks).map((block) => ({ ...block }))
    : buildMainStableSystemBlocks({
      systemPrompt: config.SYSTEM_PROMPT
    }).filter(Boolean);
  promptBlocks.push(...stablePromptBlocks);
  promptBlocks.push(
    ...personaMemoryPrompt.systemMessages
      .map((message, index) => createPromptBlock(
        `persona_memory_${index + 1}`,
        `Persona Memory ${index + 1}`,
        message?.content,
        {
          stage: 'main',
          priority: 360 + index,
          authority: 'persona_memory',
          kind: 'persona_memory',
          source: 'persona_memory',
          lane: 'dynamic_context',
          meta: {
            blockId: 'persona_memory',
            optional: true
          }
        }
      ))
      .filter(Boolean)
  );
  promptBlocks.push(createPromptBlock('retrieved_memory_lite', 'Retrieved Memory Lite', `[RetrievedMemoryLite] ${memoryContext.memoryForPrompt || 'none'}`, {
    stage: 'main',
    priority: 260,
    authority: 'memory_fact',
    kind: 'memory',
    lane: 'dynamic_context',
    meta: {
      optional: true
    }
  }));
  const rawDailyJournalPromptText = memoryContext.promptDailyJournalText || memoryContext.dailyJournalText || '';
  const dedupedDailyJournalPromptText = removeDuplicateJournalPromptText(
    rawDailyJournalPromptText,
    memoryContext.promptRetrievedMemoryText || memoryContext.memoryForPrompt || ''
  );
  const dailyJournalPromptText = dedupedDailyJournalPromptText
    || (String(rawDailyJournalPromptText || '').trim() ? 'journal evidence already included in RetrievedMemory' : '');
  promptBlocks.push(createPromptBlock('daily_journal', 'Daily Journal', `[DailyJournal]\n${dailyJournalPromptText || 'none'}`, {
    stage: 'main',
    priority: 261,
    authority: 'memory_fact',
    kind: 'memory',
    lane: 'dynamic_context',
    meta: {
      optional: true,
      evidenceOnly: true
    }
  }));
  const researchBriefText = formatResearchBriefsForPrompt(getRecentResearchBriefs(
    options.sessionKey || routeMeta.sessionKey || routeMeta.session_key || '',
    { query: question || '', limit: 2 }
  ));
  if (researchBriefText) {
    promptBlocks.push(createPromptBlock('background_research', 'Background Research', researchBriefText, {
      stage: 'main',
      priority: 320,
      authority: 'session_research',
      kind: 'research_context',
      lane: 'dynamic_context',
      meta: {
        optional: true
      }
    }));
  }
  const summaryText = promptMaterials?.summaryText
    || memoryContext.promptSummaryText
    || trimTextByTokenBudget(memoryContext.summary || 'none', affinity.shortTermMemoryTokens, 'tail')
    || 'none';
  const shortTermContinuityText = buildShortTermContinuityPrompt(sharedShortTermContext);
  if (includeOptionalContextBlocks) {
    promptBlocks.push(createPromptBlock('short_term_continuity', 'Short Term Continuity', shortTermContinuityText, {
      stage: 'main',
      priority: 210,
      authority: 'memory_fact',
      kind: 'continuity',
      lane: 'dynamic_context',
      meta: {
        optional: true,
        evidenceOnly: true
      }
    }));
    promptBlocks.push(createPromptBlock('affinity_level', 'Affinity Level', `[Affinity] ${String(userInfo?.level || '').trim() || 'stranger'}`, {
      stage: 'main',
      priority: 320,
      authority: 'memory_fact',
      kind: 'affinity',
      lane: 'dynamic_context',
      meta: {
        optional: true
      }
    }));
    promptBlocks.push(createPromptBlock('affinity_points', 'Affinity Points', `[AffinityPoints] ${affinity.points}`, {
      stage: 'main',
      priority: 321,
      authority: 'memory_fact',
      kind: 'affinity',
      lane: 'dynamic_context',
      meta: {
        optional: true
      }
    }));
    promptBlocks.push(createPromptBlock('long_term_profile', 'Long Term Profile', `[LongTermProfile] ${memoryContext.promptLongTermProfileText || memoryContext.longTermProfileText || memoryContext.profileText || 'none'}`, {
      stage: 'main',
      priority: 270,
      authority: 'memory_fact',
      kind: 'memory',
      lane: 'dynamic_context',
      meta: {
        optional: true,
        evidenceOnly: true
      }
    }));
    promptBlocks.push(createPromptBlock('impression', 'Impression', `[Impression] ${memoryContext.promptImpressionText || trimTextByTokenBudget(memoryContext.impressionText || 'none', Math.max(96, Math.floor(affinity.shortTermMemoryTokens * 0.2)), 'tail') || 'none'}`, {
      stage: 'main',
      priority: 271,
      authority: 'memory_fact',
      kind: 'memory',
      lane: 'dynamic_context',
      meta: {
        optional: true,
        evidenceOnly: true
      }
    }));
    promptBlocks.push(
      ...buildRelationshipPromptLines(memoryContext)
        .map((line, index) => createPromptBlock(
          `relationship_${index + 1}`,
          `Relationship ${index + 1}`,
          line,
          {
            stage: 'main',
            priority: 272 + index,
            authority: 'memory_fact',
            kind: 'relationship',
            lane: 'dynamic_context',
            meta: {
              optional: true,
              blockId: 'relationship_state',
              evidenceOnly: true
            }
          }
        ))
        .filter(Boolean)
    );
    promptBlocks.push(createPromptBlock('summary', 'Summary', `[Summary] ${summaryText}`, {
      stage: 'main',
      priority: 280,
      authority: 'memory_fact',
      kind: 'summary',
      lane: 'dynamic_context',
      meta: {
        optional: true,
        evidenceOnly: true
      }
    }));
  }
  const personaModuleBlocks = includePersonaModuleBlocks
    ? personaModuleDecision.selected.map((item, index) => createPromptBlock(
      `persona_module_${item.id}`,
      `Persona Module ${item.id}`,
      loadPersonaModuleText(item.id),
      {
        stage: 'main',
        priority: 520 + index,
        authority: 'persona_module',
        kind: 'persona_module',
        budgetTokens: item.tokenCost,
        conflictTags: item.conflictsWith,
        source: item.path,
        lane: 'dynamic_context',
        meta: {
          moduleId: item.id,
          optional: true
        }
      }
    )).filter(Boolean)
    : [];
  promptBlocks.push(...personaModuleBlocks);
  if (shouldExposeMemoryCli({ ...options, customPrompt })) {
    const memoryCliInstruction = buildV2MemoryCliInstruction(options?.memoryCliTurn);
    if (memoryCliInstruction) {
      promptBlocks.push(createPromptBlock('memory_cli_instruction', 'Memory CLI Instruction', memoryCliInstruction, {
        stage: 'main',
        priority: 130,
        authority: 'tool_policy',
        kind: 'tool_policy',
        source: 'memory_cli',
        lane: 'dynamic_context',
        meta: {
          optional: true
        }
      }));
    }
  }
  const dynamicFewShotPrompt = includeDynamicFewShotBlock
    ? (promptMaterials?.dynamicFewShotPrompt !== undefined
      ? promptMaterials.dynamicFewShotPrompt
      : buildDynamicFewShotPrompt({
        question,
        routePolicyKey: options.routePolicyKey,
        topRouteType: options.topRouteType,
        routePrompt: options.routePrompt,
        maxExamples: 3,
        continuitySignals: options?.continuitySignals,
        contextDensity: estimateTokens(memoryContext.memoryForPrompt || '') + estimateTokens(summaryText || '')
      }))
    : '';
  if (dynamicFewShotPrompt) {
    promptBlocks.push(createPromptBlock('dynamic_few_shot', 'Dynamic Few Shot', dynamicFewShotPrompt, {
      stage: 'main',
      priority: 620,
      authority: 'few_shot',
      budgetTokens: 220,
      kind: 'few_shot',
      source: 'few_shot',
      conflictTags: ['few_shot'],
      lane: 'assistant_only',
      meta: {
        optional: true
      }
    }));
  }
  const baseDynamicContextAudit = createDynamicContextAudit(dynamicPromptPlan);
  const defaultDynamicPromptPlan = buildHeuristicDynamicPromptPlan({
    continuitySignals: options?.continuitySignals,
    directedContext: options?.routeMeta?.directedContext,
    personaModules: dynamicPromptPlan.personaModules,
    hasAffinityState: true,
    hasShortTermContinuity: Boolean(shortTermContinuityText),
    hasRetrievedMemory: Boolean(memoryContext.promptRetrievedMemoryText || memoryContext.memoryForPrompt),
    hasDailyJournal: Boolean(dailyJournalPromptText),
    hasLongTermProfile: Boolean(memoryContext.promptLongTermProfileText || memoryContext.longTermProfileText || memoryContext.profileText),
    hasImpression: Boolean(memoryContext.promptImpressionText || memoryContext.impressionText),
    hasRelationshipState: true,
    hasDynamicFewShot: Boolean(dynamicFewShotPrompt),
    hasMemoryCliInstruction: shouldExposeMemoryCli({ ...options, customPrompt })
  });
  const useHeuristicBasePlan = dynamicPromptPlan.plannerProvided !== true;
  const effectiveBaseDynamicPromptPlan = {
    ...cloneDynamicPromptPlan(useHeuristicBasePlan ? defaultDynamicPromptPlan : dynamicPromptPlan),
    schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
    enabledBlockIds: Array.from(new Set(
      useHeuristicBasePlan
        ? normalizeArray(defaultDynamicPromptPlan.enabledBlockIds)
        : normalizeArray(dynamicPromptPlan.enabledBlockIds)
    )),
    personaModules: normalizeArray(dynamicPromptPlan.personaModules).length > 0
      ? dynamicPromptPlan.personaModules
      : defaultDynamicPromptPlan.personaModules,
    rationaleByBlock: {
      ...(useHeuristicBasePlan ? (defaultDynamicPromptPlan.rationaleByBlock || {}) : {}),
      ...(dynamicPromptPlan.rationaleByBlock || {})
    },
    blockDecisions: normalizeArray(useHeuristicBasePlan ? defaultDynamicPromptPlan.blockDecisions : dynamicPromptPlan.blockDecisions),
    plannerProvided: dynamicPromptPlan.plannerProvided === true,
    source: useHeuristicBasePlan ? 'heuristic' : normalizeText(dynamicPromptPlan.source, 'planner'),
    _source: useHeuristicBasePlan ? 'heuristic' : normalizeText(dynamicPromptPlan._source, 'planner')
  };

  const blockCatalog = getMainReplyDynamicBlockCatalog(personaModuleCandidates.map((item) => ({
    moduleId: item.id,
    purpose: item.purpose,
    triggerHints: item.triggerHints,
    tokenCost: item.tokenCost,
    conflictsWith: item.conflictsWith,
    priority: item.priority,
    phase: item.phase,
    slot: item.slot
  })));
  const baseRuntimeAddedIds = [];
  if (isGroupDirectChatRoute({ topRouteType, routeMeta })) {
    baseRuntimeAddedIds.push('persona_module:scene_group_insert');
  }
  if (options?.routeMeta?.directedContext && typeof options.routeMeta.directedContext === 'object') {
    baseRuntimeAddedIds.push('directed_context');
  }
  if (memoryContext.promptRetrievedMemoryText || memoryContext.memoryForPrompt) {
    baseRuntimeAddedIds.push('retrieved_memory_lite');
  }
  if (forceMemoryContext) {
    baseRuntimeAddedIds.push('short_term_continuity', 'retrieved_memory_lite', 'daily_journal');
  }
  const selectedPromptBlocks = filterBlocksByPlan(promptBlocks, effectiveBaseDynamicPromptPlan, {
    requiredIds: [],
    runtimeAddedIds: baseRuntimeAddedIds,
    audit: baseDynamicContextAudit,
    budgetTokens: Math.max(1200, affinity.contextWindowTokens - affinity.shortTermMemoryTokens)
  });
  const dedupedPromptBlocks = selectedPromptBlocks.filter((block) => {
    const blockId = normalizeText(block?.id);
    const evidenceOnly = block?.meta?.evidenceOnly === true;
    if (!evidenceOnly) return true;
    if (blockId === 'long_term_profile' || blockId === 'impression' || blockId.startsWith('relationship_') || blockId === 'summary') {
      return true;
    }
    return !normalizeArray(selectedPromptBlocks)
      .some((item) => normalizeText(item?.id).startsWith('persona_memory_'));
  });
  const laneSplit = splitBlocksByLane(selectedPromptBlocks);
  const normalizedLaneSplit = splitBlocksByLane(dedupedPromptBlocks);
  const snapshotBlocks = [
    ...normalizedLaneSplit.stableSystemBlocks,
    ...normalizedLaneSplit.dynamicContextBlocks,
    ...normalizedLaneSplit.assistantOnlyContextBlocks
  ];

  let promptSnapshot = buildPromptSnapshot(snapshotBlocks.filter(Boolean), {
    stage: 'main',
    policyKey: String(options?.routePolicyKey || '').trim() || 'direct_chat/main',
    budgetTokens: Math.max(1200, affinity.contextWindowTokens - affinity.shortTermMemoryTokens)
  });
  let dynamicPrompt = serializePromptBlocks(snapshotBlocks);
  const promptBudget = Math.max(1200, affinity.contextWindowTokens - affinity.shortTermMemoryTokens);
  if (estimateTokens(dynamicPrompt) > promptBudget) {
    const compactPromptBlocks = buildMainStableSystemBlocks({
      systemPrompt: config.SYSTEM_PROMPT
    }).concat(
      ...personaMemoryPrompt.systemMessages.map((message, index) => createPromptBlock(
        `persona_memory_compact_${index + 1}`,
        `Persona Memory Compact ${index + 1}`,
        message?.content,
        {
          stage: 'main',
          priority: 360 + index,
          authority: 'persona_memory',
          kind: 'persona_memory',
          lane: 'dynamic_context',
          meta: {
            optional: true,
            blockId: 'persona_memory'
          }
        }
      )).filter(Boolean),
      [
        createPromptBlock('retrieved_memory_compact', 'Retrieved Memory Compact', `[RetrievedMemoryLite] ${trimTextByTokenBudget(memoryContext.memoryForPrompt, Math.floor(promptBudget * 0.18), 'tail')}`, {
          stage: 'main',
          priority: 260,
          authority: 'memory_fact',
          kind: 'memory',
          lane: 'dynamic_context',
          meta: {
            optional: true
          }
        }),
        createPromptBlock('daily_journal_compact', 'Daily Journal Compact', `[DailyJournal]\n${trimTextByTokenBudget(dailyJournalPromptText, Math.floor(promptBudget * 0.12), 'tail') || 'none'}`, {
          stage: 'main',
          priority: 261,
          authority: 'memory_fact',
          kind: 'memory',
          lane: 'dynamic_context',
          meta: {
            optional: true,
            blockId: 'daily_journal',
            evidenceOnly: true
          }
        }),
        createPromptBlock('long_term_profile_compact', 'Long Term Profile Compact', `[LongTermProfile] ${trimTextByTokenBudget(memoryContext.promptLongTermProfileText || memoryContext.longTermProfileText || memoryContext.profileText, Math.floor(promptBudget * 0.18), 'tail') || '暂无'}`, {
          stage: 'main',
          priority: 270,
          authority: 'memory_fact',
          kind: 'memory',
          lane: 'dynamic_context',
          meta: {
            optional: true
          }
        }),
        createPromptBlock('impression_compact', 'Impression Compact', `[Impression] ${trimTextByTokenBudget(memoryContext.promptImpressionText || memoryContext.impressionText || 'none', Math.floor(promptBudget * 0.08), 'tail') || 'none'}`, {
          stage: 'main',
          priority: 271,
          authority: 'memory_fact',
          kind: 'memory',
          lane: 'dynamic_context',
          meta: {
            optional: true
          }

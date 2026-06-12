async function buildDynamicPrompt(userInfo, userId, question, customPrompt = null, options = {}) {
  const currentConfig = getConfig();
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const reviewMode = String(options?.reviewMode || '').trim().toLowerCase();
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  const adminPromptContext = resolveMainReplyAdminPromptContext({
    userId,
    routeMeta,
    options,
    config: currentConfig
  });
  const mainReplyPromptMode = resolveMainReplyPromptMode(options);
  const baseDynamicPromptPlan = normalizeDynamicPromptPlan(options);
  const fallbackAffinity = getAffinitySettings(userInfo, { userId });
  const featureFingerprint = hashText([
    String(currentConfig.MEMORY_CLI_ENABLED),
    String(currentConfig.MEMORY_CLI_CHAT_ENABLED),
    String(currentConfig.STYLE_PROFILE_ENABLED),
    String(currentConfig.SOCIAL_CONTEXT_ENABLED),
    String(currentConfig.SELF_IMPROVEMENT_ENABLED),
    String(currentConfig.SELF_IMPROVEMENT_PROMPT_ENABLED),
    String(currentConfig.LIFE_SCHEDULER_ENABLED),
    String(currentConfig.PROMPT_OPTIONAL_BUILD_ENABLED)
  ].join('|'));
  const systemPromptFingerprint = buildStableSystemPromptFingerprint(currentConfig);
  const promptModeFingerprint = hashText(mainReplyPromptMode);
  const sharedShortTermContext = buildSharedShortTermContextMessages(userId, userInfo, {
    chatHistory: options.chatHistory,
    shortTermMemory: options.shortTermMemory,
    routeMeta,
    sessionKey: options.sessionKey,
    routePolicyKey,
    topRouteType,
    question
  });
  let fallbackPersonaModuleCandidates = null;
  let fallbackPersonaModuleDecision = null;
  const fallbackPersonaModuleContext = {
    question,
    routePrompt: options.routePrompt,
    routeMeta,
    directedContext: routeMeta.directedContext,
    continuitySignals: options?.continuitySignals,
    personaPhase: routeMeta.personaPhase || '',
    chatType: getRouteMetaGroupId(routeMeta) ? 'group' : String(routeMeta.chatType || routeMeta.chat_type || options.chatType || options.chat_type || 'private').trim(),
    maxPersonaModuleCandidates: options.maxPersonaModuleCandidates,
    mainReplyPromptMode
  };
  const getFallbackPersonaModuleCandidates = () => {
    if (!fallbackPersonaModuleCandidates) {
      fallbackPersonaModuleCandidates = buildPersonaModuleCandidates(fallbackPersonaModuleContext);
    }
    return fallbackPersonaModuleCandidates;
  };
  const getFallbackPersonaModuleDecision = () => {
    if (!fallbackPersonaModuleDecision) {
      fallbackPersonaModuleDecision = selectPersonaModules(
        {
          ...(options?.personaModuleDecision || routeMeta?.directChatPlanner || routeMeta?.toolPlanner || {}),
          personaModules: normalizeArray(baseDynamicPromptPlan.personaModules).length > 0
            ? baseDynamicPromptPlan.personaModules
            : normalizeArray(options?.personaModuleDecision?.personaModules || routeMeta?.directChatPlanner?.personaModules || routeMeta?.toolPlanner?.personaModules)
        },
        {
          ...fallbackPersonaModuleContext,
          personaModuleCandidates: getFallbackPersonaModuleCandidates(),
          mainReplyPromptMode
        }
      );
    }
    return fallbackPersonaModuleDecision;
  };
  const now = Date.now();
  const essentialStartedAt = now;
  const collectStartedAt = Date.now();
  const fallbackMemoryContext = buildFallbackMemoryContext(userId, question, options, routeMeta);
  const fallbackSummaryText = fallbackMemoryContext.promptSummaryText
    || trimTextByTokenBudget(fallbackMemoryContext.summary || 'none', fallbackAffinity.shortTermMemoryTokens, 'tail')
    || 'none';
  const memoryPromptBudgetMs = resolveMemoryPromptBudgetMs(options, question);
  const buildFallbackPromptMaterials = () => {
    const fallbackMemosRecall = dedupeMemosRecallForPrompt(
      resolveMemosRecallObject(options, routeMeta, null),
      fallbackMemoryContext
    );
    const fallbackMemosRecallText = normalizeText(fallbackMemosRecall.promptText);
    const fallbackOpenVikingRecall = dedupeOpenVikingRecallForPrompt(
      resolveOpenVikingRecallObject(options, routeMeta, null),
      fallbackMemoryContext
    );
    const fallbackOpenVikingRecallText = normalizeText(fallbackOpenVikingRecall.promptText);
    return {
      userInfo,
      userId,
      question,
      customPrompt,
      routeMeta,
      routePolicyKey,
      topRouteType,
      mainReplyPromptMode,
      surface: resolveChatSurface({
        routeMeta,
        topRouteType,
        routePolicyKey,
        chatType: options.chatType || options.chat_type
      }),
      affinity: fallbackAffinity,
      sharedShortTermContext,
      memoryContext: fallbackMemoryContext,
      personaMemoryState: {},
      personaMemoryPrompt: { systemMessages: [], promptBlocks: [], policy: {} },
      personaModuleCandidates: getFallbackPersonaModuleCandidates(),
      personaWorldbookSearch: {},
      personaModuleDecision: getFallbackPersonaModuleDecision(),
      memosRecall: fallbackMemosRecall,
      memosRecallText: resolveMemosRecallText({
        memosRecall: fallbackMemosRecall,
        memosRecallText: fallbackMemosRecallText
      }, {}, { memosRecall: fallbackMemosRecall, memosRecallText: fallbackMemosRecallText }),
      openVikingRecall: fallbackOpenVikingRecall,
      openVikingRecallText: normalizeOpenVikingRecallBlockText(resolveOpenVikingRecallText({
        openVikingRecall: fallbackOpenVikingRecall,
        openVikingRecallText: fallbackOpenVikingRecallText
      }, {}, { openVikingRecall: fallbackOpenVikingRecall, openVikingRecallText: fallbackOpenVikingRecallText })),
      dynamicPromptPlan: baseDynamicPromptPlan,
      summaryText: fallbackSummaryText,
      dynamicFewShotPrompt: ''
    };
  };
  const promptMaterials = await withSoftTimeout(
    () => collectPromptInputs(userInfo, userId, question, customPrompt, {
      ...options,
      isAdmin: adminPromptContext,
      sharedShortTermContext
    }),
    memoryPromptBudgetMs,
    buildFallbackPromptMaterials
  );
  const promptCollectMs = Math.max(0, Date.now() - collectStartedAt);
  const sessionCacheFingerprint = buildSessionCacheFingerprint(userInfo, {
    ...promptMaterials,
    userId
  });
  const cacheKeys = buildPromptCacheKeys(userId, routeMeta, {
    ...options,
    featureFingerprint,
    promptModeFingerprint,
    promptManifestFingerprint: systemPromptFingerprint,
    systemPromptFingerprint,
    adminPromptContext,
    sharedShortTermSignature: sharedShortTermContext.sharedShortTermSignature,
    sessionCacheFingerprint
  });
  prunePromptLayerCache(promptLayerCache.stable, now);
  prunePromptLayerCache(promptLayerCache.session, now);
  const stableCacheHit = clonePromptLayerValue(promptLayerCache.stable.get(cacheKeys.stableKey)?.value || null);
  const sessionCacheHit = clonePromptLayerValue(promptLayerCache.session.get(cacheKeys.sessionKey)?.value || null);

  if (String(customPrompt || '').trim()) {
    const customRenderStartedAt = Date.now();
    const customBuilt = await withSoftTimeout(
      () => renderPromptLayers(promptMaterials, {
        ...options,
        isAdmin: adminPromptContext,
        sharedShortTermContext
      }),
      memoryPromptBudgetMs,
      () => ({
        dynamicPrompt: '',
        stableSystemBlocks: [],
        dynamicContextBlocks: [],
        assistantOnlyContextBlocks: [],
        promptSegments: {},
        promptSnapshot: null,
        memoryContext: promptMaterials.memoryContext || null,
        personaMemoryState: promptMaterials.personaMemoryState || null,
        affinity: promptMaterials.affinity || fallbackAffinity,
        dynamicPromptPlan: promptMaterials.dynamicPromptPlan || baseDynamicPromptPlan
      })
    );
    const promptRenderMs = Math.max(0, Date.now() - customRenderStartedAt);
    const essentialDurationMs = Math.max(0, Date.now() - essentialStartedAt);
    return {
      ...customBuilt,
      freshness: {
        stableSystem: 'bypass',
        sessionContext: 'bypass',
        continuity: String(options?.continuitySignals ? 'fresh' : 'skipped')
      },
      cacheMeta: {
        stableKey: '',
        sessionKey: '',
        hit: false,
        stableHit: false,
        sessionHit: false
      },
      latencyMeta: {
        essentialDurationMs,
        optionalDurationMs: 0,
        optionalBuildEnabled: false,
        optionalBudgetMs: 0,
        optionalBudgetExceeded: false,
        promptCollectMs,
        promptRenderMs,
        prompt_assembly_ms: promptRenderMs
      }
    };
  }

  const essentialRenderStartedAt = Date.now();
  const stableLayer = stableCacheHit || await renderPromptLayers(promptMaterials, {
    ...options,
    isAdmin: adminPromptContext,
    sharedShortTermContext,
    includeOptionalContextBlocks: false,
    includePersonaModuleBlocks: false,
    includeDynamicFewShotBlock: false,
    resolvePersonaModules: false,
    mainReplyPromptMode
  });
  const sessionCandidateLayer = await renderPromptLayers(promptMaterials, {
    ...options,
    isAdmin: adminPromptContext,
    sharedShortTermContext,
    cachedStableSystemBlocks: stableLayer.stableSystemBlocks,
    includeOptionalContextBlocks: true,
    includePersonaModuleBlocks: false,
    includeDynamicFewShotBlock: false,
    resolvePersonaModules: false,
    mainReplyPromptMode
  });
  const freshlyRenderedSessionStableBlocks = extractSessionStablePromptBlocks(sessionCandidateLayer.dynamicContextBlocks);
  const sessionReusedBlocks = normalizeArray(sessionCacheHit?.dynamicContextBlocks).length > 0
    ? clonePromptBlocks(sessionCacheHit.dynamicContextBlocks)
    : clonePromptBlocks(freshlyRenderedSessionStableBlocks);
  const sessionQueryBlocks = excludePromptBlocks(
    normalizeArray(sessionCandidateLayer.dynamicContextBlocks),
    freshlyRenderedSessionStableBlocks
  );
  const essentialRenderMs = Math.max(0, Date.now() - essentialRenderStartedAt);
  const essentialDurationMs = Math.max(0, Date.now() - essentialStartedAt);
  const shouldInjectContextStatsInstruction = !options?.disableTools
    && !reviewMode
    && (
      topRouteType === 'direct_chat'
      || routePolicyKey.startsWith('direct_chat/')
      || (!topRouteType && !routePolicyKey)
    );
  const dynamicPromptPlan = normalizeDynamicPromptPlan({
    ...options,
    dynamicPromptPlan: sessionCandidateLayer.dynamicPromptPlan || stableLayer.dynamicPromptPlan || promptMaterials.dynamicPromptPlan || baseDynamicPromptPlan
  });
  const dynamicContextAudit = createDynamicContextAudit(dynamicPromptPlan);
  const criticalBlocks = [];
  const optionalBlocks = [];
  const extraBlocks = [];
  const contextStatsInstruction = 'If the user asks about current context usage, remaining context, token usage, or whether the chat is close to the context limit, you may call get_context_stats.';
  const roleplayRuntimeContextText = buildRoleplayRuntimeContextPromptSnippet({
    userInfo,
    userId,
    question,
    routeMeta,
    routePolicyKey,
    topRouteType,
    surface: promptMaterials?.surface,
    memoryContext: promptMaterials?.memoryContext || fallbackMemoryContext,
    sharedShortTermContext,
    continuitySignals: options?.continuitySignals,
    options
  });
  const chatLivenessDisciplineText = buildChatLivenessDisciplinePrompt({
    userInfo,
    userId,
    question,
    routeMeta,
    routePolicyKey,
    topRouteType,
    surface: promptMaterials?.surface,
    memoryContext: promptMaterials?.memoryContext || fallbackMemoryContext,
    sharedShortTermContext,
    personaMemoryState: promptMaterials?.personaMemoryState,
    continuitySignals: options?.continuitySignals,
    isAdmin: adminPromptContext,
    options
  });
  const roleplayInnerProtocolText = buildRoleplayInnerProtocolPromptSnippet();

  if (roleplayRuntimeContextText) {
    extraBlocks.push(createPromptBlock('roleplay_runtime_context', 'Roleplay Runtime Context', roleplayRuntimeContextText, {
      stage: 'main',
      priority: 205,
      authority: 'runtime_context',
      kind: 'roleplay_runtime_context',
      source: 'runtime',
      lane: 'dynamic_context',
      meta: {
        optional: true
      }
    }));
  }

  if (chatLivenessDisciplineText) {
    extraBlocks.push(createPromptBlock('chat_liveness_discipline', 'Chat Liveness Discipline', chatLivenessDisciplineText, {
      stage: 'main',
      priority: 206,
      authority: 'runtime_context',
      kind: 'chat_liveness',
      source: 'runtime',
      lane: 'dynamic_context',
      meta: {
        optional: true
      }
    }));
  }

  if (roleplayInnerProtocolText) {
    extraBlocks.push(createPromptBlock('roleplay_inner_protocol', 'Roleplay Inner Protocol', roleplayInnerProtocolText, {
      stage: 'main',
      priority: 207,
      authority: 'runtime_context',
      kind: 'roleplay_inner_protocol',
      source: 'runtime',
      lane: 'dynamic_context',
      meta: {
        optional: true
      }
    }));
  }

  if (shouldInjectContextStatsInstruction) {
    extraBlocks.push(createPromptBlock('context_stats_instruction', 'Context Stats Instruction', contextStatsInstruction, {
      stage: 'main',
      priority: 140,
      authority: 'tool_policy',
      kind: 'tool_policy',
      lane: 'dynamic_context',
      meta: {
        optional: true
      }
    }));
  }

  if (isGroupDirectChatRoute({ topRouteType, routeMeta })) {
    extraBlocks.push(createPromptBlock('group_direct_chat_style_guard', 'Group Direct Chat Style Guard', buildGroupDirectChatStyleGuardPrompt(), {
      stage: 'main',
      priority: 150,
      authority: 'route_style_policy',
      kind: 'style_policy',
      lane: 'dynamic_context',
      meta: {
        optional: true
      }
    }));
  }

  const optionalBuildStartedAt = Date.now();
  const optionalBuildEnabled = currentConfig.PROMPT_OPTIONAL_BUILD_ENABLED !== false;
  const optionalBudgetMs = Math.max(0, Number(currentConfig.PROMPT_OPTIONAL_BUILD_BUDGET_MS || 0) || 0);
  const optionalBudgetExceeded = optionalBuildEnabled
    ? (optionalBudgetMs > 0 && essentialDurationMs >= optionalBudgetMs)
    : true;

  let optionalLayer = null;
  if (!optionalBudgetExceeded) {
    optionalLayer = await withSoftTimeout(
      () => renderPromptLayers(promptMaterials, {
        ...options,
        isAdmin: adminPromptContext,
        sharedShortTermContext,
        cachedStableSystemBlocks: stableLayer.stableSystemBlocks,
        includeOptionalContextBlocks: true,
        includePersonaModuleBlocks: true,
        includeDynamicFewShotBlock: shouldBuildDynamicFewShot({
          question,
          routePolicyKey,
          topRouteType,
          routePrompt: options.routePrompt,
          mainReplyPromptMode,
          forceDynamicFewShot: options.forceDynamicFewShot === true || routeMeta.forceDynamicFewShot === true,
          dynamicFewShotEnabled: options.dynamicFewShotEnabled === true || routeMeta.dynamicFewShotEnabled === true
        }),
        resolvePersonaModules: true,
        mainReplyPromptMode
      }),
      Math.max(0, optionalBudgetMs - essentialDurationMs),
      null
    );
  }
  const effectiveOptionalLayer = optionalLayer && typeof optionalLayer === 'object' ? optionalLayer : null;

  if (!optionalBudgetExceeded && shouldInjectLifeScheduler(options)) {
    const lifeSchedulerEngine = getLifeSchedulerEngine();
    if (lifeSchedulerEngine && typeof lifeSchedulerEngine.ensureCaches === 'function') {
      lifeSchedulerEngine.ensureCaches();
    }
    const injection = lifeSchedulerEngine?.getInjectionEntry?.(new Date()) || null;
    const injectionEntry = injection?.entry || null;
    if (injectionEntry && String(injectionEntry.status || '').trim() === 'ok') {
      const injectionBlock = lifeSchedulerEngine.formatInjectionBlock(injectionEntry, new Date());
      if (String(injectionBlock || '').trim()) {
        extraBlocks.push(createPromptBlock('life_scheduler', 'Life Scheduler', injectionBlock, {
          stage: 'main',
          priority: 700,
          authority: 'optional_modulation',
          kind: 'scheduler',
          lane: 'dynamic_context',
          meta: {
            optional: true
          }
        }));
      }
    }
  }

  if (!optionalBudgetExceeded && (!isBalancedOrMinimalPromptMode(mainReplyPromptMode) || options.forceStyleProfile === true || routeMeta.forceStyleProfile === true) && shouldInjectStyleProfile(options)) {
    const styleSnippet = buildStyleProfileSnippet({
      groupId: String(routeMeta.groupId || routeMeta.group_id || '').trim(),
      maxChars: currentConfig.STYLE_PROFILE_PROMPT_MAX_CHARS
    });
    if (styleSnippet) {
      extraBlocks.push(createPromptBlock('style_profile', 'Style Profile', styleSnippet, {
        stage: 'main',
        priority: 710,
        authority: 'optional_modulation',
        kind: 'style_profile',
        lane: 'dynamic_context',
        meta: {
          optional: true
        }
      }));
    }
  }

  if (options?.routeMeta?.directedContext && typeof options.routeMeta.directedContext === 'object') {
    const directedContextText = buildDirectedContextPromptSnippet(options.routeMeta.directedContext);
    extraBlocks.push(createPromptBlock('directed_context', 'Directed Context', directedContextText, {
      stage: 'main',
      priority: 210,
      authority: 'continuity_context',
      kind: 'continuity',
      lane: 'dynamic_context',
      meta: {
        optional: true
      }
    }));
  }

  const collectedMemoryContextForPolicy = promptMaterials?.memoryContext && typeof promptMaterials.memoryContext === 'object'
    ? promptMaterials.memoryContext
    : {};
  const memoryRecallPolicyText = buildMemoryRecallPolicyPromptSnippet(collectedMemoryContextForPolicy);
  if (memoryRecallPolicyText) {
    extraBlocks.push(createPromptBlock('memory_recall_policy', 'Memory Recall Policy', memoryRecallPolicyText, {
      stage: 'main',
      priority: 255,
      authority: 'memory_policy',
      kind: 'memory_policy',
      source: 'memory_v3_recall_policy',
      lane: 'dynamic_context',
      meta: {
        optional: true,
        evidenceOnly: true
      }
    }));
  }

  const continuityStateText = buildContinuityStatePromptSnippet(options?.continuitySignals);
  if (continuityStateText) {
    extraBlocks.push(createPromptBlock('continuity_state', 'Continuity State', continuityStateText, {
      stage: 'main',
      priority: 220,
      authority: 'continuity_context',
      kind: 'continuity',
      lane: 'dynamic_context',
      meta: {
        optional: true
      }
    }));
  }

  if (!optionalBudgetExceeded && (!isBalancedOrMinimalPromptMode(mainReplyPromptMode) || options.forceSocialContext === true || routeMeta.forceSocialContext === true) && shouldInjectSocialContext(options)) {
    const socialSnippet = buildSocialContextSnippet({
      groupId: String(routeMeta.groupId || routeMeta.group_id || '').trim(),
      maxChars: currentConfig.SOCIAL_CONTEXT_PROMPT_MAX_CHARS
    });
    if (socialSnippet) {
      extraBlocks.push(createPromptBlock('social_context', 'Social Context', socialSnippet, {
        stage: 'main',
        priority: 720,
        authority: 'optional_modulation',
        kind: 'social_context',
        lane: 'dynamic_context',
        meta: {
          optional: true
        }
      }));
    }
  }

  if (!optionalBudgetExceeded && (!isBalancedOrMinimalPromptMode(mainReplyPromptMode) || options.forceSelfImprovement === true || routeMeta.forceSelfImprovement === true) && shouldInjectSelfImprovement(options)) {
    const snippet = buildPromptSnippet({
      query: question,
      routePolicyKey: String(options?.routePolicyKey || routeMeta.routePolicyKey || '').trim(),
      topRouteType: String(options?.topRouteType || routeMeta.topRouteType || '').trim(),
      toolName: String(routeMeta.toolName || routeMeta.tool_name || '').trim(),
      topK: currentConfig.SELF_IMPROVEMENT_PROMPT_TOP_K,
      maxChars: currentConfig.SELF_IMPROVEMENT_PROMPT_MAX_CHARS
    });
    if (snippet) {
      extraBlocks.push(createPromptBlock('self_improvement', 'Self Improvement', snippet, {
        stage: 'main',
        priority: 730,
        authority: 'optional_modulation',
        kind: 'self_improvement',
        lane: 'dynamic_context',
        meta: {
          optional: true
        }
      }));
    }
  }

  if (isGroupDirectChatRoute({ topRouteType, routeMeta })) {
    const optionalLayerHasGroupModule = normalizeArray(effectiveOptionalLayer?.dynamicContextBlocks)
      .some((item) => normalizeText(item?.meta?.moduleId) === 'scene_group_insert');
    if (!optionalLayerHasGroupModule) {
      extraBlocks.push(createPromptBlock('persona_module_scene_group_insert', 'Persona Module scene_group_insert', loadPersonaModuleText('scene_group_insert'), {
        stage: 'main',
        priority: 520,
        authority: 'persona_module',
        kind: 'persona_module',
        budgetTokens: 58,
        source: 'persona_modules/scene_group_insert.txt',
        lane: 'dynamic_context',
        meta: {
          moduleId: 'scene_group_insert',
          optional: true
        }
      }));
    }
  }

  const memoryCliInstruction = !optionalBudgetExceeded ? buildV2MemoryCliInstruction(options?.memoryCliTurn) : '';
  const forceMemoryContext = shouldForceMemoryContextForQuestion(question, {
    ...options,
    routeMeta
  });
  const combinedStableBlocks = normalizeArray(stableLayer.stableSystemBlocks).map((item) => ({ ...item }));
  const sessionDynamicFingerprints = new Set(
    normalizeArray(sessionCandidateLayer.dynamicContextBlocks).map((item) => buildPromptBlockFingerprint(item)).filter(Boolean)
  );
  const sessionAssistantOnlyFingerprints = new Set(
    normalizeArray(sessionCandidateLayer.assistantOnlyContextBlocks).map((item) => buildPromptBlockFingerprint(item)).filter(Boolean)
  );
  const optionalUniqueDynamicBlocks = normalizeArray(effectiveOptionalLayer?.dynamicContextBlocks)
    .filter((item) => !sessionDynamicFingerprints.has(buildPromptBlockFingerprint(item)));
  const optionalUniqueAssistantOnlyBlocks = normalizeArray(effectiveOptionalLayer?.assistantOnlyContextBlocks)
    .filter((item) => !sessionAssistantOnlyFingerprints.has(buildPromptBlockFingerprint(item)));
  const combinedDynamicBlocks = dedupePromptBlocks(
    clonePromptBlocks(sessionReusedBlocks)
      .concat(clonePromptBlocks(sessionQueryBlocks))
      .concat(clonePromptBlocks(optionalUniqueDynamicBlocks))
  );
  const combinedAssistantOnlyBlocks = dedupePromptBlocks(
    clonePromptBlocks(sessionCandidateLayer.assistantOnlyContextBlocks)
      .concat(clonePromptBlocks(optionalUniqueAssistantOnlyBlocks))
  );
  const effectiveCombinedAssistantOnlyBlocks = shouldBuildDynamicFewShot({
    question,
    routePolicyKey,
    topRouteType,
    routePrompt: options.routePrompt,
    mainReplyPromptMode,
    forceDynamicFewShot: options.forceDynamicFewShot === true || routeMeta.forceDynamicFewShot === true,
    dynamicFewShotEnabled: options.dynamicFewShotEnabled === true || routeMeta.dynamicFewShotEnabled === true
  })
    ? combinedAssistantOnlyBlocks
    : combinedAssistantOnlyBlocks.filter((item) => item?.id !== 'dynamic_few_shot');
  const heuristicDynamicPlan = buildHeuristicDynamicPromptPlan({
    continuitySignals: options?.continuitySignals,
    directedContext: options?.routeMeta?.directedContext,
    personaModules: dynamicPromptPlan.personaModules,
    forceMemoryContext,
    hasRoleplayRuntimeContext: Boolean(roleplayRuntimeContextText),
    hasChatLivenessDiscipline: Boolean(chatLivenessDisciplineText),
    hasRoleplayInnerProtocol: Boolean(roleplayInnerProtocolText),
    hasAffinityState: true,
    hasShortTermContinuity: combinedDynamicBlocks.some((item) => item?.id === 'short_term_continuity'),
    hasMemoryRecallPolicy: combinedDynamicBlocks.some((item) => item?.id === 'memory_recall_policy' || normalizeText(item?.meta?.blockId) === 'memory_recall_policy')
      || extraBlocks.some((item) => item?.id === 'memory_recall_policy'),
    hasRetrievedMemory: combinedDynamicBlocks.some((item) => item?.id === 'retrieved_memory_lite'),
    hasMemosRecall: combinedDynamicBlocks.some((item) => item?.id === 'memos_recall' || normalizeText(item?.meta?.blockId) === 'memos_recall')
      || Boolean(resolveMemosRecallText(options, routeMeta, promptMaterials)),
    hasOpenVikingRecall: combinedDynamicBlocks.some((item) => item?.id === 'openviking_recall' || normalizeText(item?.meta?.blockId) === 'openviking_recall')
      || Boolean(resolveOpenVikingRecallText(options, routeMeta, promptMaterials)),
    hasDailyJournal: combinedDynamicBlocks.some((item) => item?.id === 'daily_journal' || normalizeText(item?.meta?.blockId) === 'daily_journal'),
    hasLongTermProfile: combinedDynamicBlocks.some((item) => item?.id === 'long_term_profile'),
    hasImpression: combinedDynamicBlocks.some((item) => item?.id === 'impression'),
    hasRelationshipState: combinedDynamicBlocks.some((item) => normalizeText(item?.meta?.blockId) === 'relationship_state'),
    hasDynamicFewShot: effectiveCombinedAssistantOnlyBlocks.some((item) => item?.id === 'dynamic_few_shot'),
    hasStyleProfile: combinedDynamicBlocks.some((item) => item?.id === 'style_profile') || extraBlocks.some((item) => item?.id === 'style_profile'),
    hasSocialContext: combinedDynamicBlocks.some((item) => item?.id === 'social_context') || extraBlocks.some((item) => item?.id === 'social_context'),
    hasSelfImprovement: combinedDynamicBlocks.some((item) => item?.id === 'self_improvement') || extraBlocks.some((item) => item?.id === 'self_improvement'),
    hasLifeScheduler: combinedDynamicBlocks.some((item) => item?.id === 'life_scheduler') || extraBlocks.some((item) => item?.id === 'life_scheduler'),
    hasContextStatsInstruction: extraBlocks.some((item) => item?.id === 'context_stats_instruction'),
    hasMemoryCliInstruction: Boolean(memoryCliInstruction && shouldExposeMemoryCli(options)),
    mainReplyPromptMode
  });
  const plannerProvidedDynamicPlan = dynamicPromptPlan.plannerProvided === true;
  const shouldUseHeuristicDynamicPlan = !plannerProvidedDynamicPlan;
  const runtimeAddedIds = ['roleplay_runtime_context', 'chat_liveness_discipline', 'roleplay_inner_protocol'];
  if (isGroupDirectChatRoute({ topRouteType, routeMeta })) {
    runtimeAddedIds.push('group_direct_chat_style_guard', 'persona_module:scene_group_insert');
  }
  if (options?.routeMeta?.directedContext && typeof options.routeMeta.directedContext === 'object') {
    runtimeAddedIds.push('directed_context');
  }
  if (combinedDynamicBlocks.some((item) => item?.id === 'short_term_continuity')) {
    runtimeAddedIds.push('short_term_continuity');
  }
  const collectedMemoryContext = promptMaterials?.memoryContext && typeof promptMaterials.memoryContext === 'object'
    ? promptMaterials.memoryContext
    : {};
  if (shouldRuntimeAddRetrievedMemoryBlock(question, {
    ...options,
    routeMeta
  }, dynamicPromptPlan, collectedMemoryContext)) {
    runtimeAddedIds.push('memory_recall_policy', 'retrieved_memory_lite');
  }
  if (forceMemoryContext) {
    runtimeAddedIds.push('short_term_continuity', 'memory_recall_policy', 'retrieved_memory_lite', 'daily_journal');
  }
  const finalDynamicPromptPlan = {
    ...cloneDynamicPromptPlan(shouldUseHeuristicDynamicPlan ? heuristicDynamicPlan : dynamicPromptPlan),
    schemaVersion: DYNAMIC_CONTEXT_PLAN_VERSION,
    enabledBlockIds: Array.from(new Set(
      shouldUseHeuristicDynamicPlan
        ? normalizeArray(heuristicDynamicPlan.enabledBlockIds)
        : normalizeArray(dynamicPromptPlan.enabledBlockIds)
    )),
    rationaleByBlock: {
      ...(shouldUseHeuristicDynamicPlan ? (heuristicDynamicPlan.rationaleByBlock || {}) : {}),
      ...(dynamicPromptPlan.rationaleByBlock || {})
    },
    blockDecisions: normalizeArray(shouldUseHeuristicDynamicPlan ? heuristicDynamicPlan.blockDecisions : dynamicPromptPlan.blockDecisions),
    plannerProvided: plannerProvidedDynamicPlan,
    source: shouldUseHeuristicDynamicPlan ? 'heuristic' : normalizeText(dynamicPromptPlan.source, plannerProvidedDynamicPlan ? 'planner' : 'heuristic'),
    _source: shouldUseHeuristicDynamicPlan ? 'heuristic' : normalizeText(dynamicPromptPlan._source, plannerProvidedDynamicPlan ? 'planner' : 'heuristic')
  };
  const memoryCliBlock = memoryCliInstruction
    && shouldExposeMemoryCli(options)
    ? createPromptBlock('memory_cli_followup', 'Memory CLI Followup', memoryCliInstruction, {
      stage: 'main',
      priority: 130,
      authority: 'tool_policy',
      kind: 'tool_policy',
      lane: 'dynamic_context',
      meta: {
        optional: true
      }
    })
    : null;
  const rawCombinedBlocks = [
    ...combinedStableBlocks,
    ...combinedDynamicBlocks,
    ...effectiveCombinedAssistantOnlyBlocks,
    ...extraBlocks,
    ...(memoryCliBlock ? [memoryCliBlock] : [])
  ];
  const promptMaterialsMemoryContext = promptMaterials?.memoryContext && typeof promptMaterials.memoryContext === 'object'
    ? promptMaterials.memoryContext
    : {};
  const optionsMemoryContext = options.memoryContext && typeof options.memoryContext === 'object'
    ? options.memoryContext
    : {};
  const visibleMemoryContextForDedupe = {
    ...collectedMemoryContext,
    ...promptMaterialsMemoryContext,
    ...optionsMemoryContext,
    segments: {
      ...(collectedMemoryContext.segments || {}),
      ...(promptMaterialsMemoryContext.segments || {}),
      ...(optionsMemoryContext.segments || {})
    }
  };
  const combinedBlocks = dedupePromptBlocks(rawCombinedBlocks).filter((block) => {
    const ids = getPromptBlockPlanIds(block).ids;
    if (ids.includes('memos_recall')) {
      const deduped = dedupeMemosRecallForPrompt({
        used: true,
        promptText: normalizeText(block?.content),
        items: []
      }, visibleMemoryContextForDedupe);
      return !(deduped?.used === false && normalizeText(deduped?.rejectedReason) === 'deduped_by_local_memory');
    }
    if (ids.includes('openviking_recall')) {
      const deduped = dedupeOpenVikingRecallForPrompt({
        used: true,
        promptText: normalizeText(block?.content),
        items: [{ id: 'prompt_block', text: normalizeText(block?.content) }]
      }, visibleMemoryContextForDedupe);
      return !(deduped?.used === false && normalizeText(deduped?.rejectedReason) === 'deduped_by_local_memory');
    }
    return true;
  });
  const requiredIds = normalizeArray(stableLayer.promptSnapshot?.stableBlockIds);
  const finalMemosRecall = dedupeMemosRecallForPrompt(
    resolveMemosRecallObject(options, routeMeta, promptMaterials),
    visibleMemoryContextForDedupe
  );
  const finalBlockedIds = finalMemosRecall?.used === false
    && normalizeText(finalMemosRecall?.rejectedReason) === 'deduped_by_local_memory'
    ? ['memos_recall']
    : [];
  const hasLocalMemosDuplicate = finalBlockedIds.includes('memos_recall')
    || (
      options.memoryContext
      && typeof options.memoryContext === 'object'
      && dedupeMemosRecallForPrompt(
        resolveMemosRecallObject(options, routeMeta, promptMaterials),
        options.memoryContext
      )?.rejectedReason === 'deduped_by_local_memory'
    );
  if (hasLocalMemosDuplicate && !finalBlockedIds.includes('memos_recall')) {
    finalBlockedIds.push('memos_recall');
  }
  const finalOpenVikingRecall = dedupeOpenVikingRecallForPrompt(
    resolveOpenVikingRecallObject(options, routeMeta, promptMaterials),
    visibleMemoryContextForDedupe
  );
  const hasLocalOpenVikingDuplicate = (
    finalOpenVikingRecall?.used === false
    && normalizeText(finalOpenVikingRecall?.rejectedReason) === 'deduped_by_local_memory'
  ) || (
    options.memoryContext
    && typeof options.memoryContext === 'object'
    && dedupeOpenVikingRecallForPrompt(
      resolveOpenVikingRecallObject(options, routeMeta, promptMaterials),
      options.memoryContext
    )?.rejectedReason === 'deduped_by_local_memory'
  );
  if (hasLocalOpenVikingDuplicate && !finalBlockedIds.includes('openviking_recall')) {
    finalBlockedIds.push('openviking_recall');
  }
  if (shouldBlockAmbientMemoryForPlainChat(question, {
    ...options,
    routeMeta
  }, finalDynamicPromptPlan)) {
    for (const blockId of ['retrieved_memory_lite', 'daily_journal', 'memory_recall_policy']) {
      if (!finalBlockedIds.includes(blockId)) finalBlockedIds.push(blockId);
    }
  }
  const selectedBlocks = filterBlocksByPlan(combinedBlocks, finalDynamicPromptPlan, {
    requiredIds,
    runtimeAddedIds,
    blockedIds: finalBlockedIds,
    audit: dynamicContextAudit,
    budgetTokens: Math.max(1200, fallbackAffinity.contextWindowTokens - fallbackAffinity.shortTermMemoryTokens)
  });
  for (const block of selectedBlocks) {
    const isCritical = isCriticalDynamicContextBlock(block);
    if (isCritical) criticalBlocks.push(block);
    else optionalBlocks.push(block);
  }

  const includedOptionalBlocks = (!optionalBuildEnabled || optionalBudgetExceeded)
    ? []
    : optionalBlocks;
  const laneSplit = splitBlocksByLane(criticalBlocks.concat(includedOptionalBlocks));
  const mergedSnapshot = buildPromptSnapshot(
    [
      ...laneSplit.stableSystemBlocks,
      ...laneSplit.dynamicContextBlocks,
      ...laneSplit.assistantOnlyContextBlocks
    ].filter(Boolean),
    {
      stage: 'main',
      policyKey: String(options?.routePolicyKey || '').trim() || 'direct_chat/main',
      isAdmin: adminPromptContext
    }
  );

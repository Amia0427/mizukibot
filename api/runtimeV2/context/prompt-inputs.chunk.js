async function collectPromptInputs(userInfo, userId, question, customPrompt = null, options = {}) {
  const routeMeta = options.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const dynamicPromptPlan = normalizeDynamicPromptPlan(options);
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  const surface = buildPromptSurface(topRouteType, routeMeta);
  const affinity = options.affinity && typeof options.affinity === 'object'
    ? options.affinity
    : getAffinitySettings(userInfo, { userId });
  const sharedShortTermContext = options.sharedShortTermContext && typeof options.sharedShortTermContext === 'object'
    ? options.sharedShortTermContext
    : buildSharedShortTermContextMessages(userId, userInfo, {
      chatHistory: options.chatHistory,
      shortTermMemory: options.shortTermMemory,
      routeMeta,
      sessionKey: options.sessionKey
    });
  const personaModuleContext = {
    question,
    routePrompt: options.routePrompt,
    routeMeta,
    directedContext: routeMeta.directedContext,
    continuitySignals: options?.continuitySignals,
    personaPhase: routeMeta.personaPhase || '',
    chatType: getRouteMetaGroupId(routeMeta) ? 'group' : String(routeMeta.chatType || routeMeta.chat_type || '').trim()
  };
  const personaModuleCandidatesPromise = buildPersonaModuleCandidatesAsync(personaModuleContext)
    .catch((error) => ({ __personaModuleCandidatesError: error }));
  const memoryContext = options.memoryContext && typeof options.memoryContext === 'object'
    ? options.memoryContext
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
      sharedShortTermSignature: sharedShortTermContext.sharedShortTermSignature
    });
  const personaMemoryState = options.personaMemoryState && typeof options.personaMemoryState === 'object'
    ? options.personaMemoryState
    : await composePersonaMemoryState({
      userId,
      question: question || '',
      routeMeta,
      routePolicyKey,
      topRouteType
    }, {
      userInfo,
      surface,
      sessionKey: options.sessionKey,
      shortTermMemory: options.shortTermMemory,
      chatHistory: options.chatHistory,
      personaModules: dynamicPromptPlan.personaModules,
      sharedShortTermContext,
      memoryContext
    });
  const personaMemoryPrompt = options.personaMemoryPrompt && typeof options.personaMemoryPrompt === 'object'
    ? options.personaMemoryPrompt
    : renderPersonaMemoryPrompt(personaMemoryState, topRouteType === 'proactive' ? 'proactive_touch' : 'direct_chat');
  const personaModuleCandidates = await personaModuleCandidatesPromise;
  if (personaModuleCandidates?.__personaModuleCandidatesError) {
    throw personaModuleCandidates.__personaModuleCandidatesError;
  }
  const personaWorldbookSearch = personaModuleCandidates.personaWorldbookSearch || {};
  const personaModuleDecision = selectPersonaModules(
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
      personaModuleCandidates
    }
  );
  const summaryText = memoryContext?.promptSummaryText
    || trimTextByTokenBudget(memoryContext?.summary || 'none', affinity.shortTermMemoryTokens, 'tail')
    || 'none';
  const dynamicFewShotPrompt = buildDynamicFewShotPrompt({
    question,
    routePolicyKey: options.routePolicyKey,
    topRouteType: options.topRouteType,
    routePrompt: options.routePrompt,
    maxExamples: 3,
    continuitySignals: options?.continuitySignals,
    contextDensity: estimateTokens(memoryContext?.memoryForPrompt || '') + estimateTokens(summaryText || '')
  });
  return {
    userInfo,
    userId,
    question,
    customPrompt,
    routeMeta,
    routePolicyKey,
    topRouteType,
    surface,
    affinity,
    sharedShortTermContext,
    memoryContext,
    personaMemoryState,
    personaMemoryPrompt,
    personaModuleCandidates,
    personaWorldbookSearch,
    personaModuleDecision,
    dynamicPromptPlan,
    summaryText,
    dynamicFewShotPrompt
  };
}


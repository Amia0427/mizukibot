function buildDirectChatPlannerOptions({
  route = {},
  inboundContext = {},
  directedContext = null,
  userId = '',
  contextSummary = '',
  requestTrace = null,
  includeRuntimeMetadata = false
} = {}) {
  const meta = route?.meta || {};
  const options = {
    userId,
    allowedTools: meta.allowedTools,
    contextSummary,
    directedContext,
    continuitySignals: meta.continuitySignals || inboundContext.continuitySignals || {},
    memoryContext: inboundContext.memoryContext || meta.memoryContext || {},
    availableContextSignals: meta.availableContextSignals || inboundContext.availableContextSignals || {},
    personaModuleCatalog: meta.personaModuleCatalog || [],
    dynamicPromptBlockCatalog: meta.dynamicPromptBlockCatalog || [],
    dynamicPromptGuide: meta.dynamicPromptGuide || '',
    dynamicFewShotPrompt: inboundContext.dynamicFewShotPrompt || meta.dynamicFewShotPrompt || '',
    mainReplyPromptMode: inboundContext.mainReplyPromptMode || meta.mainReplyPromptMode || '',
    memoryCliTurn: inboundContext.memoryCliTurn || meta.memoryCliTurn || {},
    schedulerInjection: inboundContext.schedulerInjection || meta.schedulerInjection || meta.lifeSchedulerInjection || '',
    sharedShortTermContext: inboundContext.sharedShortTermContext || meta.sharedShortTermContext || {},
    personaMemoryState: inboundContext.personaMemoryState || meta.personaMemoryState || {}
  };
  if (includeRuntimeMetadata) {
    options.userInfo = inboundContext.userInfo || {};
    options.requestTrace = requestTrace;
  }
  return options;
}

module.exports = {
  buildDirectChatPlannerOptions
};

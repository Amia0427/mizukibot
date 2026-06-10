        }),
        createPromptBlock('summary_compact', 'Summary Compact', `[Summary] ${trimTextByTokenBudget(memoryContext.promptSummaryText || memoryContext.summary || 'none', Math.floor(promptBudget * 0.12), 'tail') || 'none'}`, {
          stage: 'main',
          priority: 280,
          authority: 'memory_fact',
          kind: 'summary',
          lane: 'dynamic_context',
          meta: {
            optional: true
          }
        })
      ]
    );
    const compactSelectedBlocks = filterBlocksByPlan(compactPromptBlocks, effectiveBaseDynamicPromptPlan, {
      requiredIds: [],
      runtimeAddedIds: baseRuntimeAddedIds,
      blockedIds: baseBlockedIds,
      audit: baseDynamicContextAudit,
      budgetTokens: promptBudget
    });
    promptSnapshot = buildPromptSnapshot(compactSelectedBlocks.filter(Boolean), {
      stage: 'main',
      policyKey: String(options?.routePolicyKey || '').trim() || 'direct_chat/main_compact',
      budgetTokens: promptBudget,
      isAdmin: adminPromptContext
    });
    dynamicPrompt = serializePromptBlocks(compactSelectedBlocks);
  }

  const compiledLaneSplit = splitBlocksByLane(promptSnapshot.assembledBlocks);
  promptSegments.systemPrompt = blocksToMessages(compiledLaneSplit.stableSystemBlocks.concat(compiledLaneSplit.dynamicContextBlocks));
  promptSegments.assembledBlocks = promptSnapshot.assembledBlocks;
  promptSegments.renderedSystemMessages = promptSnapshot.renderedSystemMessages;
  promptSegments.tokenUsageByBlock = promptSnapshot.tokenUsageByBlock;
  promptSegments.trimDecisions = promptSnapshot.trimDecisions;
  promptSegments.securityLabels = Array.isArray(options?.securityLabels) ? options.securityLabels : [];
  promptSegments.activatedPersonaModules = personaModuleDecision.selected.map((item) => item.id);
  promptSegments.personaModuleCandidates = personaModuleCandidates.map((item) => item.id);
  promptSegments.personaModuleTokenUsage = personaModuleDecision.selected.map((item) => ({
    id: item.id,
    tokenCost: item.tokenCost
  }));
  promptSegments.stableSystemBlocks = compiledLaneSplit.stableSystemBlocks;
  promptSegments.dynamicContextBlocks = compiledLaneSplit.dynamicContextBlocks;
  promptSegments.assistantOnlyContextBlocks = compiledLaneSplit.assistantOnlyContextBlocks;

  return {
    dynamicPrompt,
    stableSystemBlocks: compiledLaneSplit.stableSystemBlocks,
    dynamicContextBlocks: compiledLaneSplit.dynamicContextBlocks,
    assistantOnlyContextBlocks: compiledLaneSplit.assistantOnlyContextBlocks,
    promptSegments,
    promptSnapshot: {
      ...promptSnapshot,
      activatedPersonaModules: promptSegments.activatedPersonaModules,
      personaModuleCandidates: promptSegments.personaModuleCandidates,
      personaModuleTokenUsage: promptSegments.personaModuleTokenUsage,
      stableBlockIds: compiledLaneSplit.stableSystemBlocks.map((item) => item.id),
      dynamicBlockIds: compiledLaneSplit.dynamicContextBlocks.map((item) => item.id),
      assistantOnlyBlockIds: compiledLaneSplit.assistantOnlyContextBlocks.map((item) => item.id),
      plannerChosenDynamicBlocks: effectiveBaseDynamicPromptPlan.enabledBlockIds,
      plannerDynamicContextPlan: baseDynamicContextAudit.plannerDynamicContextPlan,
      plannerIncludedBlocks: baseDynamicContextAudit.plannerIncludedBlocks,
      plannerSkippedBlocks: baseDynamicContextAudit.plannerSkippedBlocks,
      runtimeAddedBlocks: baseDynamicContextAudit.runtimeAddedBlocks,
      runtimeRejectedBlocks: baseDynamicContextAudit.runtimeRejectedBlocks,
      selectionTrace: normalizeArray(baseDynamicContextAudit.selectionTrace),
      budgetReport: baseDynamicContextAudit.budgetReport || null,
      personaWorldbookSearch,
      candidatePruning: personaModuleCandidates.candidatePruning || {},
      cacheFriendlyFingerprint: buildCacheFriendlyFingerprint(compiledLaneSplit.stableSystemBlocks),
      cacheLanes: {
        stable: compiledLaneSplit.stableSystemBlocks.map((item) => item.id),
        dynamic: compiledLaneSplit.dynamicContextBlocks.map((item) => item.id),
        assistantOnly: compiledLaneSplit.assistantOnlyContextBlocks.map((item) => item.id)
      },
      dynamicPromptBlockCatalog: blockCatalog,
      dynamicPromptPlan: effectiveBaseDynamicPromptPlan
    },
    memoryContext,
    personaMemoryState,
    affinity,
    dynamicPromptPlan: effectiveBaseDynamicPromptPlan,
    personaMemoryPrompt,
    personaModuleCandidates,
    personaWorldbookSearch,
    personaModuleDecision,
    sharedShortTermSignature: String(sharedShortTermContext?.sharedShortTermSignature || '').trim(),
    summaryText,
    promptBudget: Math.max(1200, affinity.contextWindowTokens - affinity.shortTermMemoryTokens),
    dynamicFewShotPrompt,
    mainReplyPromptMode,
    optionalContextBlocksIncluded: includeOptionalContextBlocks,
    optionalPersonaModuleBlocksIncluded: includePersonaModuleBlocks,
    optionalDynamicFewShotIncluded: includeDynamicFewShotBlock,
    dynamicPromptBlockCatalog: blockCatalog
  };
}


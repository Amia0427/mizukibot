  const promptSegments = {
    ...(sessionCandidateLayer.promptSegments || {}),
    systemPrompt: blocksToMessages(laneSplit.stableSystemBlocks.concat(laneSplit.dynamicContextBlocks)),
    assembledBlocks: mergedSnapshot.assembledBlocks,
    renderedSystemMessages: mergedSnapshot.renderedSystemMessages,
    tokenUsageByBlock: mergedSnapshot.tokenUsageByBlock,
    trimDecisions: mergedSnapshot.trimDecisions,
    stableSystemBlocks: laneSplit.stableSystemBlocks,
    dynamicContextBlocks: laneSplit.dynamicContextBlocks,
    assistantOnlyContextBlocks: laneSplit.assistantOnlyContextBlocks,
    securityLabels: Array.isArray(options?.securityLabels) ? options.securityLabels : [],
    activatedPersonaModules: normalizeArray(effectiveOptionalLayer?.promptSegments?.activatedPersonaModules),
    personaModuleCandidates: normalizeArray(effectiveOptionalLayer?.promptSegments?.personaModuleCandidates),
    personaModuleTokenUsage: normalizeArray(effectiveOptionalLayer?.promptSegments?.personaModuleTokenUsage)
  };
  for (const skippedModule of normalizeArray(effectiveOptionalLayer?.personaModuleDecision?.selectionReason?.skipped)) {
    const moduleId = normalizeText(skippedModule?.id);
    if (!moduleId) continue;
    pushUniqueAuditEntry(dynamicContextAudit.runtimeRejectedBlocks, {
      id: `persona_module:${moduleId}`,
      moduleId,
      reason: normalizeText(skippedModule?.reason, 'persona_module_selection_rejected')
    });
  }
  const enrichedSnapshot = {
    ...mergedSnapshot,
    activatedPersonaModules: promptSegments.activatedPersonaModules,
    personaModuleCandidates: promptSegments.personaModuleCandidates,
    personaModuleTokenUsage: promptSegments.personaModuleTokenUsage,
    stableBlockIds: laneSplit.stableSystemBlocks.map((item) => item.id),
    dynamicBlockIds: laneSplit.dynamicContextBlocks.map((item) => item.id),
    assistantOnlyBlockIds: laneSplit.assistantOnlyContextBlocks.map((item) => item.id),
    plannerChosenDynamicBlocks: finalDynamicPromptPlan.enabledBlockIds,
    plannerDynamicContextPlan: dynamicContextAudit.plannerDynamicContextPlan,
    plannerIncludedBlocks: dynamicContextAudit.plannerIncludedBlocks,
    plannerSkippedBlocks: dynamicContextAudit.plannerSkippedBlocks,
    runtimeAddedBlocks: dynamicContextAudit.runtimeAddedBlocks,
    runtimeRejectedBlocks: dynamicContextAudit.runtimeRejectedBlocks,
    selectionTrace: normalizeArray(dynamicContextAudit.selectionTrace),
    budgetReport: dynamicContextAudit.budgetReport || null,
    personaWorldbookSearch: (
      effectiveOptionalLayer?.promptSnapshot?.personaWorldbookSearch
      || sessionCandidateLayer?.promptSnapshot?.personaWorldbookSearch
      || promptMaterials?.personaWorldbookSearch
      || {}
    ),
    candidatePruning: (
      effectiveOptionalLayer?.promptSnapshot?.candidatePruning
      || sessionCandidateLayer?.promptSnapshot?.candidatePruning
      || promptMaterials?.candidatePruning
      || {}
    ),
    cacheFriendlyFingerprint: buildCacheFriendlyFingerprint(laneSplit.stableSystemBlocks),
    cacheLanes: {
      stable: laneSplit.stableSystemBlocks.map((item) => item.id),
      dynamic: laneSplit.dynamicContextBlocks.map((item) => item.id),
      assistantOnly: laneSplit.assistantOnlyContextBlocks.map((item) => item.id)
    },
    dynamicPromptBlockCatalog: effectiveOptionalLayer?.dynamicPromptBlockCatalog || sessionCandidateLayer.dynamicPromptBlockCatalog || [],
    dynamicPromptPlan: finalDynamicPromptPlan
  };
  const stableHit = Boolean(stableCacheHit);
  const sessionHit = Boolean(sessionCacheHit && normalizeArray(sessionCacheHit.dynamicContextBlocks).length > 0);
  const freshness = {
    stableSystem: stableHit ? 'cache' : 'fresh',
    sessionContext: sessionHit ? 'cache' : 'fresh',
    continuity: String(options?.continuitySignals ? 'fresh' : 'skipped')
  };
  const cacheMeta = {
    stableKey: cacheKeys.stableKey,
    sessionKey: cacheKeys.sessionKey,
    hit: stableHit || sessionHit,
    stableHit: stableHit,
    sessionHit: sessionHit
  };

  if (!stableHit && normalizeArray(stableLayer.stableSystemBlocks).length > 0) {
    promptLayerCache.stable.set(cacheKeys.stableKey, {
      expiresAt: now + Math.max(0, Number(currentConfig.PROMPT_STABLE_CACHE_TTL_MS || 0)),
      value: clonePromptLayerValue({
        stableSystemBlocks: normalizeArray(stableLayer.stableSystemBlocks).map((item) => ({ ...item })),
        promptSnapshot: stableLayer.promptSnapshot || null,
        promptSegments: {
          stableSystemBlocks: normalizeArray(stableLayer.promptSegments?.stableSystemBlocks).map((item) => ({ ...item }))
        },
        dynamicPromptPlan: stableLayer.dynamicPromptPlan || baseDynamicPromptPlan
      })
    });
  }
  if (normalizeArray(freshlyRenderedSessionStableBlocks).length > 0) {
    promptLayerCache.session.set(cacheKeys.sessionKey, {
      expiresAt: now + Math.max(0, Number(currentConfig.PROMPT_SESSION_CACHE_TTL_MS || 0)),
      value: clonePromptLayerValue({
        dynamicContextBlocks: freshlyRenderedSessionStableBlocks,
        assistantOnlyContextBlocks: [],
        promptSnapshot: {
          dynamicBlockIds: freshlyRenderedSessionStableBlocks.map((item) => item.id)
        },
        promptSegments: {
          dynamicContextBlocks: freshlyRenderedSessionStableBlocks
        },
        cacheMeta: {
          sessionKey: cacheKeys.sessionKey
        }
      })
    });
  }

  const optionalDurationMs = Math.max(0, Date.now() - optionalBuildStartedAt);
  const promptRenderMs = essentialRenderMs + optionalDurationMs;
  buildStage.end({ status: 'ok' });
  const promptAssemblyStageTimings = promptAssemblyTiming.snapshot({
    totalDurationMs: Math.max(0, Date.now() - essentialStartedAt),
    promptCollectMs,
    promptRenderMs
  });
  enrichedSnapshot.promptAssemblyStageTimings = promptAssemblyStageTimings;
  enrichedSnapshot.stageTimings = promptAssemblyStageTimings;
  return {
    dynamicPrompt: serializePromptBlocks([
      ...laneSplit.stableSystemBlocks,
      ...laneSplit.dynamicContextBlocks,
      ...laneSplit.assistantOnlyContextBlocks
    ]),
    stableSystemBlocks: laneSplit.stableSystemBlocks,
    dynamicContextBlocks: laneSplit.dynamicContextBlocks,
    assistantOnlyContextBlocks: laneSplit.assistantOnlyContextBlocks,
    promptSnapshot: enrichedSnapshot,
    promptSegments,
    dynamicPromptPlan: finalDynamicPromptPlan,
    criticalBlocks,
    optionalBlocks: includedOptionalBlocks,
    memoryContext: promptMaterials.memoryContext || effectiveOptionalLayer?.memoryContext || sessionCandidateLayer.memoryContext || null,
    personaMemoryState: promptMaterials.personaMemoryState || effectiveOptionalLayer?.personaMemoryState || sessionCandidateLayer.personaMemoryState || null,
    affinity: promptMaterials.affinity || effectiveOptionalLayer?.affinity || sessionCandidateLayer.affinity || stableLayer.affinity || fallbackAffinity,
    freshness,
    cacheMeta,
    latencyMeta: {
      essentialDurationMs,
      optionalDurationMs,
      optionalBuildEnabled,
      optionalBudgetMs,
      optionalBudgetExceeded,
      promptCollectMs,
      promptRenderMs,
      prompt_assembly_ms: promptRenderMs,
      promptAssemblyStageTimings,
      stageTimings: promptAssemblyStageTimings
    },
    dynamicFewShotPrompt: effectiveCombinedAssistantOnlyBlocks.some((item) => item?.id === 'dynamic_few_shot')
      ? (effectiveOptionalLayer?.dynamicFewShotPrompt || sessionCandidateLayer.dynamicFewShotPrompt || promptMaterials.dynamicFewShotPrompt || '')
      : '',
    mainReplyPromptMode
  };
}


function splitBlocksByLane(blocks = []) {
  const lanes = {
    stableSystemBlocks: [],
    dynamicContextBlocks: [],
    assistantOnlyContextBlocks: []
  };

  for (const block of normalizeArray(blocks)) {
    if (!block || typeof block !== 'object') continue;
    const lane = normalizeText(block.lane || block.cacheLane, 'dynamic_context');
    if (lane === 'stable_system') lanes.stableSystemBlocks.push(block);
    else if (lane === 'assistant_only') lanes.assistantOnlyContextBlocks.push(block);
    else lanes.dynamicContextBlocks.push(block);
  }

  return lanes;
}

function buildCacheFriendlyFingerprint(stableSystemBlocks = []) {
  return hashText(
    normalizeArray(stableSystemBlocks)
      .map((item) => `${normalizeText(item.id)}::${normalizeText(item.content)}`)
      .join('\n---\n')
  );
}

function buildSessionCacheFingerprint(userInfo = {}, promptMaterials = {}) {
  const affinity = promptMaterials?.affinity && typeof promptMaterials.affinity === 'object'
    ? promptMaterials.affinity
    : getAffinitySettings(userInfo, { userId: promptMaterials?.userId });
  return hashText([
    normalizeText(userInfo?.level || ''),
    String(Number(userInfo?.points || affinity?.points || 0) || 0),
    normalizeText(promptMaterials?.memosRecallText),
    normalizeText(promptMaterials?.openVikingRecallText || promptMaterials?.openvikingRecallText)
  ].join('|'));
}

function withSoftTimeout(taskFactory, timeoutMs, fallbackValue) {
  const budget = Math.max(0, Number(timeoutMs) || 0);
  if (!budget) return Promise.resolve(typeof taskFactory === 'function' ? taskFactory() : fallbackValue);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(typeof fallbackValue === 'function' ? fallbackValue() : fallbackValue);
    }, budget);
    Promise.resolve()
      .then(() => (typeof taskFactory === 'function' ? taskFactory() : taskFactory))
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(typeof fallbackValue === 'function' ? fallbackValue() : fallbackValue);
      });
  });
}

const promptLayerCache = {
  stable: new Map(),
  session: new Map()
};

function prunePromptLayerCache(cache = new Map(), now = Date.now()) {
  for (const [key, entry] of cache.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      cache.delete(key);
    }
  }
}

function buildPromptCacheKeys(userId = '', routeMeta = {}, options = {}) {
  const normalizedRouteMeta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  const stableKey = hashText([
    normalizeText(options.routePolicyKey),
    normalizeText(options.topRouteType),
    normalizeText(options.reviewMode),
    normalizeText(options.featureFingerprint),
    normalizeText(options.promptModeFingerprint),
    normalizeText(options.promptManifestFingerprint),
    normalizeText(options.systemPromptFingerprint),
    normalizeText(options.modelName || options.model_name || options.model),
    options.adminPromptContext === true ? 'admin' : 'user'
  ].join('|'));
  const sessionKey = hashText([
    normalizeText(userId),
    normalizeText(options.sessionKey),
    normalizeText(normalizedRouteMeta.groupId || normalizedRouteMeta.group_id),
    normalizeText(options.sessionCacheFingerprint || options.sharedShortTermSignature)
  ].join('|'));
  return { stableKey, sessionKey };
}

function getCachedPromptLayer(cache = new Map(), key = '', ttlMs = 0, factory = null) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && Number(entry.expiresAt || 0) > now) {
    return {
      value: entry.value,
      hit: true
    };
  }
  const value = typeof factory === 'function' ? factory() : null;
  if (key && Number(ttlMs || 0) > 0 && value) {
    cache.set(key, {
      expiresAt: now + Math.max(0, Number(ttlMs || 0) || 0),
      value
    });
  }
  return {
    value,
    hit: false
  };
}

function clonePromptBlocks(blocks = []) {
  return normalizeArray(blocks).map((block) => {
    if (!block || typeof block !== 'object') return block;
    return {
      ...block,
      conflictTags: normalizeArray(block.conflictTags),
      meta: block.meta && typeof block.meta === 'object' ? { ...block.meta } : {}
    };
  });
}

function clonePromptMessages(messages = []) {
  return normalizeArray(messages).map((message) => (
    message && typeof message === 'object' ? { ...message } : message
  ));
}

function clonePromptLayerValue(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const normalized = value;
  const promptSnapshot = normalized.promptSnapshot && typeof normalized.promptSnapshot === 'object'
    ? {
        ...normalized.promptSnapshot,
        assembledBlocks: clonePromptBlocks(normalized.promptSnapshot.assembledBlocks),
        renderedSystemMessages: clonePromptMessages(normalized.promptSnapshot.renderedSystemMessages),
        tokenUsageByBlock: normalizeArray(normalized.promptSnapshot.tokenUsageByBlock).map((item) => ({ ...item })),
        trimDecisions: normalizeArray(normalized.promptSnapshot.trimDecisions).map((item) => ({ ...item })),
        stableBlockIds: normalizeArray(normalized.promptSnapshot.stableBlockIds),
        dynamicBlockIds: normalizeArray(normalized.promptSnapshot.dynamicBlockIds),
        assistantOnlyBlockIds: normalizeArray(normalized.promptSnapshot.assistantOnlyBlockIds),
        plannerChosenDynamicBlocks: normalizeArray(normalized.promptSnapshot.plannerChosenDynamicBlocks),
        plannerDynamicContextPlan: cloneDynamicPromptPlan(normalized.promptSnapshot.plannerDynamicContextPlan),
        plannerIncludedBlocks: normalizeArray(normalized.promptSnapshot.plannerIncludedBlocks).map((item) => ({ ...item })),
        plannerSkippedBlocks: normalizeArray(normalized.promptSnapshot.plannerSkippedBlocks).map((item) => ({ ...item })),
        runtimeAddedBlocks: normalizeArray(normalized.promptSnapshot.runtimeAddedBlocks).map((item) => ({ ...item })),
        runtimeRejectedBlocks: normalizeArray(normalized.promptSnapshot.runtimeRejectedBlocks).map((item) => ({ ...item })),
        selectionTrace: normalizeArray(normalized.promptSnapshot.selectionTrace).map((item) => ({ ...item })),
        budgetReport: normalized.promptSnapshot.budgetReport && typeof normalized.promptSnapshot.budgetReport === 'object'
          ? {
              ...normalized.promptSnapshot.budgetReport,
              usedByLane: normalized.promptSnapshot.budgetReport.usedByLane && typeof normalized.promptSnapshot.budgetReport.usedByLane === 'object'
                ? { ...normalized.promptSnapshot.budgetReport.usedByLane }
                : {},
              blocks: normalizeArray(normalized.promptSnapshot.budgetReport.blocks).map((item) => ({ ...item }))
            }
          : null,
        candidatePruning: normalized.promptSnapshot.candidatePruning && typeof normalized.promptSnapshot.candidatePruning === 'object'
          ? {
              ...normalized.promptSnapshot.candidatePruning,
              keptIds: normalizeArray(normalized.promptSnapshot.candidatePruning.keptIds),
              droppedIds: normalizeArray(normalized.promptSnapshot.candidatePruning.droppedIds),
              alwaysKeepIds: normalizeArray(normalized.promptSnapshot.candidatePruning.alwaysKeepIds)
            }
          : undefined,
        personaWorldbookSearch: normalized.promptSnapshot.personaWorldbookSearch && typeof normalized.promptSnapshot.personaWorldbookSearch === 'object'
          ? { ...normalized.promptSnapshot.personaWorldbookSearch }
          : undefined,
        cacheLanes: normalized.promptSnapshot.cacheLanes && typeof normalized.promptSnapshot.cacheLanes === 'object'
          ? {
              stable: normalizeArray(normalized.promptSnapshot.cacheLanes.stable),
              dynamic: normalizeArray(normalized.promptSnapshot.cacheLanes.dynamic),
              assistantOnly: normalizeArray(normalized.promptSnapshot.cacheLanes.assistantOnly)
            }
          : undefined
      }
    : (normalized.promptSnapshot || null);
  return {
    ...normalized,
    stableSystemBlocks: clonePromptBlocks(normalized.stableSystemBlocks),
    dynamicContextBlocks: clonePromptBlocks(normalized.dynamicContextBlocks),
    assistantOnlyContextBlocks: clonePromptBlocks(normalized.assistantOnlyContextBlocks),
    promptSnapshot,
    promptSegments: normalized.promptSegments && typeof normalized.promptSegments === 'object'
      ? {
          ...normalized.promptSegments,
          systemPrompt: clonePromptMessages(normalized.promptSegments.systemPrompt),
          routePrompt: clonePromptMessages(normalized.promptSegments.routePrompt),
          personaMemory: clonePromptMessages(normalized.promptSegments.personaMemory),
          assembledBlocks: clonePromptBlocks(normalized.promptSegments.assembledBlocks),
          renderedSystemMessages: clonePromptMessages(normalized.promptSegments.renderedSystemMessages),
          tokenUsageByBlock: normalizeArray(normalized.promptSegments.tokenUsageByBlock).map((item) => ({ ...item })),
          trimDecisions: normalizeArray(normalized.promptSegments.trimDecisions).map((item) => ({ ...item })),
          stableSystemBlocks: clonePromptBlocks(normalized.promptSegments.stableSystemBlocks),
          dynamicContextBlocks: clonePromptBlocks(normalized.promptSegments.dynamicContextBlocks),
          assistantOnlyContextBlocks: clonePromptBlocks(normalized.promptSegments.assistantOnlyContextBlocks),
          activatedPersonaModules: normalizeArray(normalized.promptSegments.activatedPersonaModules),
          personaModuleCandidates: normalizeArray(normalized.promptSegments.personaModuleCandidates),
          personaModuleTokenUsage: normalizeArray(normalized.promptSegments.personaModuleTokenUsage).map((item) => ({ ...item })),
          securityLabels: normalizeArray(normalized.promptSegments.securityLabels)
        }
      : {},
    dynamicPromptPlan: normalized.dynamicPromptPlan && typeof normalized.dynamicPromptPlan === 'object'
      ? cloneDynamicPromptPlan(normalized.dynamicPromptPlan)
      : {},
    dynamicPromptBlockCatalog: normalizeArray(normalized.dynamicPromptBlockCatalog).map((item) => ({ ...item })),
    personaModuleCandidates: normalizeArray(normalized.personaModuleCandidates).map((item) => ({ ...item })),
    personaModuleDecision: normalized.personaModuleDecision && typeof normalized.personaModuleDecision === 'object'
      ? {
          ...normalized.personaModuleDecision,
          selected: normalizeArray(normalized.personaModuleDecision.selected).map((item) => ({ ...item })),
          rejected: normalizeArray(normalized.personaModuleDecision.rejected).map((item) => ({ ...item }))
        }
      : { selected: [], rejected: [] },
    cacheMeta: normalized.cacheMeta && typeof normalized.cacheMeta === 'object'
      ? { ...normalized.cacheMeta }
      : {}
  };
}

function buildPromptSurface(topRouteType = '', routeMeta = {}) {
  const normalizedRouteMeta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  if (String(topRouteType || '').trim().toLowerCase() === 'proactive') return 'proactive_touch';
  return resolveChatSurface({
    topRouteType,
    routeMeta: normalizedRouteMeta
  });
}

function dedupePromptBlocks(blocks = []) {
  const seen = new Set();
  const out = [];
  for (const block of normalizeArray(blocks)) {
    if (!block || typeof block !== 'object') continue;
    const key = `${normalizeText(block.id)}::${normalizeText(block.content)}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }
  return out;
}

function buildPromptBlockFingerprint(block = {}) {
  return `${normalizeText(block?.id)}::${normalizeText(block?.content)}`;
}

function extractSessionStablePromptBlocks(blocks = []) {
  return normalizeArray(blocks).filter((block) => {
    const blockId = normalizeText(block?.id);
    if (!blockId) return false;
    return blockId === 'affinity_level'
      || blockId === 'affinity_points'
      || blockId.startsWith('relationship_');
  });
}

function excludePromptBlocks(blocks = [], excludedBlocks = []) {
  const excluded = new Set(normalizeArray(excludedBlocks).map((block) => buildPromptBlockFingerprint(block)).filter(Boolean));
  if (excluded.size === 0) return normalizeArray(blocks);
  return normalizeArray(blocks).filter((block) => !excluded.has(buildPromptBlockFingerprint(block)));
}


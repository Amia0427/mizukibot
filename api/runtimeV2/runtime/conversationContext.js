function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasMessageContent(message = {}) {
  if (typeof message?.content === 'string') return Boolean(String(message.content || '').trim());
  if (Array.isArray(message?.content)) {
    return message.content.some((part) => {
      if (typeof part === 'string') return Boolean(String(part || '').trim());
      if (part && typeof part.text === 'string') return Boolean(String(part.text || '').trim());
      return false;
    });
  }
  if (message?.content && typeof message.content === 'object') {
    return Boolean(String(message.content.text || message.content.content || '').trim());
  }
  return false;
}

function createConversationContextHelpers(deps = {}) {
  const OPENAI_COMPATIBLE_CACHE_CONTROL = Object.freeze({
    type: 'ephemeral',
    ttl: '5m'
  });
  const {
    config,
    normalizeToolNames,
    filterAllowedToolsForMemoryCliTurn,
    mergeAllowedToolsWithMemoryCli,
    isPlannerSingleAuthorityEnabled,
    getRouteToolPlanner,
    resolveModelTokenLimit,
    buildSecuritySystemPrompt
  } = deps;

  function computeEffectiveAllowedTools(request = {}, memoryCliTurn = null) {
    if (isPlannerSingleAuthorityEnabled()) {
      const planner = getRouteToolPlanner(request.routeMeta);
      const plannedTools = normalizeToolNames(
        Array.isArray(planner?.allowedToolNames) ? planner.allowedToolNames : []
      );
      return filterAllowedToolsForMemoryCliTurn(plannedTools, memoryCliTurn);
    }
    return mergeAllowedToolsWithMemoryCli(request.allowedTools, {
      ...request,
      disableTools: !request.allowTools,
      memoryCliTurn
    });
  }

  function resolveMainConversationModelName(request = {}) {
    const modelConfig = normalizeObject(request.modelConfig, {});
    return String(modelConfig.model || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
  }

  function resolveMainConversationTokenLimit(request = {}, affinity = null) {
    const normalizedAffinity = normalizeObject(affinity, {});
    const fallbackLimit = Math.max(
      1,
      Number(normalizedAffinity.contextWindowTokens || config.CONTEXT_WINDOW_MAX_TOKENS || 32000) || 32000
    );
    return resolveModelTokenLimit(resolveMainConversationModelName(request), fallbackLimit);
  }

  function buildContinuitySystemMessage(state) {
    if (!config.CONTINUITY_STATE_PROMPT_ENABLED) return null;
    const text = String(state.memory?.continuityState?.text || '').trim();
    if (!text) return null;
    return { role: 'system', content: text };
  }

  function buildSilentContinuityProbeSystemMessage(state) {
    const probe = normalizeObject(state.memory?.continuityState?.probe, {});
    if (probe.skipped || !String(probe.facet || '').trim()) return null;
    return {
      role: 'system',
      content: [
        '[ContinuityProbePolicy]',
        'A read-only continuity probe may already have run before this reply.',
        'Use any continuity digest silently as background context.',
        'Do not mention tools, tool calls, tool results, memory_cli, probe steps, search commands, or retrieved snippets in the final answer.',
        'Do not narrate hidden retrieval or command execution. Reply as if you already know the carry-over context.'
      ].join('\n')
    };
  }

  function stripMemoryCliInstruction(text = '') {
    const raw = String(text || '');
    if (!raw.includes('[MemoryCLI]')) return raw;
    const lines = raw.split(/\r?\n/);
    const kept = [];
    let skipping = false;
    for (const line of lines) {
      if (line.startsWith('[MemoryCLI]')) {
        skipping = true;
        continue;
      }
      if (skipping && /^\[[A-Za-z]/.test(line)) {
        skipping = false;
      }
      if (!skipping) kept.push(line);
    }
    return kept.join('\n').trim();
  }

  function mapBlocksToMessages(blocks = [], role = 'system') {
    return normalizeArray(blocks)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        role,
        content: String(item.content || '').trim()
      }))
      .filter((item) => hasMessageContent(item));
  }

  function attachCacheControlToMessage(message = {}, cacheControl = null) {
    const content = String(message?.content || '').trim();
    if (!content || !cacheControl) return message;
    return {
      ...message,
      content: [
        {
          type: 'text',
          text: content,
          cache_control: cacheControl
        }
      ]
    };
  }

  function shouldCacheStableSystemBlock(block = {}) {
    const blockId = String(block?.id || '').trim();
    if (!blockId) return false;
    return [
      'main_persona_system',
      'security_contract',
      'core_baseline_patch'
    ].includes(blockId);
  }

  function mapStableSystemBlocksToMessages(blocks = []) {
    return normalizeArray(blocks)
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const base = {
          role: 'system',
          content: String(item.content || '').trim()
        };
        return shouldCacheStableSystemBlock(item)
          ? attachCacheControlToMessage(base, OPENAI_COMPATIBLE_CACHE_CONTROL)
          : base;
      })
      .filter((item) => hasMessageContent(item));
  }

  function mapDynamicContextBlocksToMessages(blocks = []) {
    return normalizeArray(blocks)
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        role: 'system',
        content: String(item.content || '').trim()
      }))
      .filter((item) => hasMessageContent(item));
  }

  function buildAssistantOnlyContextMessages(state) {
    return normalizeArray(state.memory?.assistantOnlyContextBlocks)
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const message = {
          role: 'assistant',
          content: String(item.content || '').trim()
        };
        return message;
      })
      .filter((item) => hasMessageContent(item));
  }

  function getMainConversationSystemMessages(state, options = {}) {
    const request = normalizeObject(state.request, {});
    const isReviewRoute = Boolean(options.isReviewRoute);
    const stableSystemBlocks = normalizeArray(state.memory?.stableSystemBlocks);
    const dynamicContextBlocks = normalizeArray(state.memory?.dynamicContextBlocks);
    const dynamicPrompt = Boolean(options.disableMemoryCliInstruction)
      ? stripMemoryCliInstruction(String(state.memory?.dynamicPrompt || ''))
      : String(state.memory?.dynamicPrompt || '').trim();
    const continuityMessage = buildContinuitySystemMessage(state);
    const continuityProbePolicyMessage = buildSilentContinuityProbeSystemMessage(state);
    const dynamicPlan = normalizeObject(state.memory?.promptSnapshot?.dynamicPromptPlan, {});
    const enabledDynamicIds = new Set(normalizeArray(dynamicPlan.enabledBlockIds).map((item) => String(item || '').trim()).filter(Boolean));
    const forceIncludeContinuity = Boolean(
      state.memory?.continuityState?.payload?.active_topic
      || normalizeArray(state.memory?.continuityState?.payload?.open_loops).length > 0
      || normalizeArray(state.memory?.continuityState?.payload?.assistant_commitments).length > 0
    );
    const stableBlockMessages = mapStableSystemBlocksToMessages(stableSystemBlocks);
    const dynamicBlockMessages = mapDynamicContextBlocksToMessages(dynamicContextBlocks)
      .filter((message) => hasMessageContent(message));
    const fallbackDynamicMessages = (!stableBlockMessages.length && dynamicPrompt)
      ? [{ role: 'system', content: dynamicPrompt }]
      : [];
    return [
      ...stableBlockMessages,
      ...((continuityMessage && (forceIncludeContinuity || enabledDynamicIds.has('continuity_state'))) ? [continuityMessage] : []),
      ...(continuityProbePolicyMessage ? [continuityProbePolicyMessage] : []),
      ...((request.routePrompt && !isReviewRoute) ? [{ role: 'system', content: request.routePrompt }] : []),
      ...(state.memory?.globalToolEvidence ? [{ role: 'system', content: state.memory.globalToolEvidence }] : []),
      ...dynamicBlockMessages,
      ...fallbackDynamicMessages
    ];
  }

  return {
    buildAssistantOnlyContextMessages,
    buildContinuitySystemMessage,
    computeEffectiveAllowedTools,
    getMainConversationSystemMessages,
    normalizeArray,
    normalizeObject,
    resolveMainConversationModelName,
    resolveMainConversationTokenLimit,
    stripMemoryCliInstruction
  };
}

module.exports = {
  createConversationContextHelpers
};

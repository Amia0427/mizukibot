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

function dynamicPromptHasContextMarker(text = '') {
  return /\[(?:RetrievedMemoryLite|RetrievedMemory|DailyJournal|TaskMemory|GroupMemory|StyleSignals|ShortTermContinuity|MemOSRecall|LongTermProfile|Impression|Summary|ContinuityState)\]/i.test(String(text || ''));
}

const CANONICAL_CONTEXT_DYNAMIC_BLOCK_SEGMENTS = Object.freeze({
  retrieved_memory_lite: ['retrievedMemory', 'taskMemory', 'groupMemory', 'styleSignals'],
  retrieved_memory_compact: ['retrievedMemory', 'taskMemory', 'groupMemory', 'styleSignals'],
  daily_journal: ['dailyJournal'],
  daily_journal_compact: ['dailyJournal'],
  task_memory: ['taskMemory'],
  group_memory: ['groupMemory'],
  style_signals: ['styleSignals']
});

const SHORT_TERM_CONTEXT_DYNAMIC_BLOCK_IDS = new Set([
  'short_term_continuity',
  'short_term_continuity_compact'
]);

function buildAnthropicCompatibleCacheControl() {
  const { normalizeAnthropicCacheControl } = require('../../../src/model/http/cache-control');
  return Object.freeze(normalizeAnthropicCacheControl(true));
}

function createConversationContextHelpers(deps = {}) {
  const ANTHROPIC_COMPATIBLE_CACHE_CONTROL = buildAnthropicCompatibleCacheControl();
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
      const filteredPlannedTools = config.MEMORY_CLI_ENABLED && config.MEMORY_CLI_CHAT_ENABLED
        ? plannedTools
        : plannedTools.filter((toolName) => toolName !== 'memory_cli');
      return filterAllowedToolsForMemoryCliTurn(filteredPlannedTools, memoryCliTurn);
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
      'admin_system_prompt',
      'root_system_prompt',
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
          ? attachCacheControlToMessage(base, ANTHROPIC_COMPATIBLE_CACHE_CONTROL)
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

  function normalizeBlockId(value = '') {
    return String(value || '').trim().toLowerCase();
  }

  function getPromptBlockIds(block = {}) {
    return Array.from(new Set([
      block.id,
      block.blockId,
      block.meta?.blockId
    ].map(normalizeBlockId).filter(Boolean)));
  }

  function isChatLikeMainConversationRequest(request = {}) {
    const routeMeta = normalizeObject(request.routeMeta, {});
    const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
    const topRouteType = String(request.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
    if (request.systemInitiated || String(request.customPrompt || '').trim() || String(request.reviewMode || '').trim()) return false;
    if (!topRouteType && !routePolicyKey) return true;
    return topRouteType === 'direct_chat' || routePolicyKey.startsWith('direct_chat/');
  }

  function hasCanonicalContextSegment(memoryContext = {}, segmentKeys = []) {
    const segments = normalizeObject(memoryContext.segments, {});
    return normalizeArray(segmentKeys).some((key) => (
      normalizeArray(segments[key]).some((message) => hasMessageContent(message))
    ));
  }

  function shouldSendDynamicBlockAsSystemMessage(block = {}, state = {}) {
    const blockIds = getPromptBlockIds(block);
    if (blockIds.length === 0) return true;
    if (
      isChatLikeMainConversationRequest(state.request)
      && blockIds.some((id) => SHORT_TERM_CONTEXT_DYNAMIC_BLOCK_IDS.has(id))
    ) {
      return false;
    }
    const memoryContext = normalizeObject(state.memory?.context, {});
    return !blockIds.some((id) => (
      hasCanonicalContextSegment(memoryContext, CANONICAL_CONTEXT_DYNAMIC_BLOCK_SEGMENTS[id])
    ));
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
    const continuityPayload = normalizeObject(state.memory?.continuityState?.payload, {});
    const forceIncludeContinuity = Boolean(
      String(continuityPayload.carry_over_user_turn || '').trim()
      || normalizeArray(continuityPayload.open_loops).length > 0
      || normalizeArray(continuityPayload.assistant_commitments).length > 0
      || normalizeArray(continuityPayload.user_constraints).length > 0
      || normalizeArray(continuityPayload.continuity_probe_digest).length > 0
    );
    const stableBlockMessages = mapStableSystemBlocksToMessages(stableSystemBlocks);
    const dynamicBlockMessages = mapDynamicContextBlocksToMessages(
      dynamicContextBlocks.filter((block) => shouldSendDynamicBlockAsSystemMessage(block, state))
    )
      .filter((message) => hasMessageContent(message));
    const fallbackDynamicMessages = (
      dynamicPrompt
      && dynamicContextBlocks.length === 0
      && (!stableBlockMessages.length || dynamicPromptHasContextMarker(dynamicPrompt))
    )
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

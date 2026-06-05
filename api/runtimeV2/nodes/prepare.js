const { buildPromptSnapshot } = require('../../../utils/promptCompiler');
const { buildMainStableSystemBlocks } = require('../../../utils/stagePromptContracts');
const {
  recordMainPromptBlockObservation
} = require('../../../utils/memoryRecallObservability');
const { classifyMemoryNeed } = require('../../../utils/recallHeuristics');

function createPrepareNode(deps = {}) {
  const normalizeObject = typeof deps.normalizeObject === 'function'
    ? deps.normalizeObject
    : ((value, fallback = {}) => (value && typeof value === 'object' ? value : fallback));
  const normalizeArray = typeof deps.normalizeArray === 'function'
    ? deps.normalizeArray
    : ((value) => (Array.isArray(value) ? value : []));
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const loadCheckpoint = typeof deps.loadCheckpoint === 'function'
    ? deps.loadCheckpoint
    : (() => null);
  const shouldExposeMemoryCli = typeof deps.shouldExposeMemoryCli === 'function'
    ? deps.shouldExposeMemoryCli
    : (() => false);
  const recordMemoryScope = typeof deps.recordMemoryScope === 'function'
    ? deps.recordMemoryScope
    : () => {};
  const restoreShortTermBridgeAfterRestartIfNeeded = typeof deps.restoreShortTermBridgeAfterRestartIfNeeded === 'function'
    ? deps.restoreShortTermBridgeAfterRestartIfNeeded
    : (() => ({ restored: false }));
  const rehydrateShortTermMemoryAfterRestartIfNeeded = typeof deps.rehydrateShortTermMemoryAfterRestartIfNeeded === 'function'
    ? deps.rehydrateShortTermMemoryAfterRestartIfNeeded
    : () => {};
  const compressShortTermHistoryIfNeeded = typeof deps.compressShortTermHistoryIfNeeded === 'function'
    ? deps.compressShortTermHistoryIfNeeded
    : (async () => {});
  const summarizeShortTermChunk = typeof deps.summarizeShortTermChunk === 'function'
    ? deps.summarizeShortTermChunk
    : null;
  const buildStructuredCompressionPrompt = typeof deps.buildStructuredCompressionPrompt === 'function'
    ? deps.buildStructuredCompressionPrompt
    : (() => '');
  const postWithRetry = typeof deps.postWithRetry === 'function'
    ? deps.postWithRetry
    : (async () => ({}));
  const extractMessageContent = typeof deps.extractMessageContent === 'function'
    ? deps.extractMessageContent
    : ((value) => value);
  const isChatLikeRoute = typeof deps.isChatLikeRoute === 'function'
    ? deps.isChatLikeRoute
    : (() => false);
  const persistShortTermBridgeSnapshot = typeof deps.persistShortTermBridgeSnapshot === 'function'
    ? deps.persistShortTermBridgeSnapshot
    : () => {};
  const appendMemoryEvent = typeof deps.appendMemoryEvent === 'function'
    ? deps.appendMemoryEvent
    : (async () => {});
  const materializeMemoryViews = typeof deps.materializeMemoryViews === 'function'
    ? deps.materializeMemoryViews
    : (() => null);
  const maybeRunAutoContinuityProbe = typeof deps.maybeRunAutoContinuityProbe === 'function'
    ? deps.maybeRunAutoContinuityProbe
    : (async () => ({ skipped: true, reason: 'disabled', events: [], probeResult: null, probeMeta: null }));
  const buildContinuityState = typeof deps.buildContinuityState === 'function'
    ? deps.buildContinuityState
    : (() => ({ payload: null, text: '', hasSufficientEvidence: false }));
  const createMemoryCliTurnState = typeof deps.createMemoryCliTurnState === 'function'
    ? deps.createMemoryCliTurnState
    : ((value) => value || null);
  const computeEffectiveAllowedTools = typeof deps.computeEffectiveAllowedTools === 'function'
    ? deps.computeEffectiveAllowedTools
    : (() => []);
  const runCapabilityPreflight = typeof deps.runCapabilityPreflight === 'function'
    ? deps.runCapabilityPreflight
    : (async () => null);
  const buildDynamicPromptImpl = typeof deps.buildDynamicPromptImpl === 'function'
    ? deps.buildDynamicPromptImpl
    : (async () => ({ dynamicPrompt: '', affinity: null, memoryContext: null }));
  const buildFallbackMemoryContextImpl = typeof deps.buildFallbackMemoryContextImpl === 'function'
    ? deps.buildFallbackMemoryContextImpl
    : ((userId, question, options = {}) => {
        try {
          return require('../../../utils/memoryContext').buildMemoryContext(userId, question, options);
        } catch (_) {
          return {};
        }
      });
  const buildSharedShortTermContextMessagesImpl = typeof deps.buildSharedShortTermContextMessages === 'function'
    ? deps.buildSharedShortTermContextMessages
    : ((userId, userInfo, options = {}) => {
        try {
          return require('../../../utils/shortTermMemory').buildSharedShortTermContextMessages(userId, userInfo, options);
        } catch (_) {
          return {};
        }
      });
  const getMemosRecallPromptTextImpl = typeof deps.getMemosRecallPromptText === 'function'
    ? deps.getMemosRecallPromptText
    : ((memosRecall = {}) => {
        try {
          return require('../../../utils/memosPlannerRecall').getMemosRecallPromptText(memosRecall);
        } catch (_) {
          return '';
        }
      });
  const getOpenVikingRecallPromptTextImpl = typeof deps.getOpenVikingRecallPromptText === 'function'
    ? deps.getOpenVikingRecallPromptText
    : ((openVikingRecall = {}) => {
        try {
          return require('../../../utils/openVikingMemory/recall').getOpenVikingRecallPromptText(openVikingRecall);
        } catch (_) {
          return '';
        }
      });
  const dedupeOpenVikingRecallImpl = typeof deps.dedupeOpenVikingRecall === 'function'
    ? deps.dedupeOpenVikingRecall
    : ((openVikingRecall = {}, memoryContext = {}) => {
        try {
          return require('../../../utils/openVikingMemory/deduper').dedupeOpenVikingRecallAgainstMemoryContext(openVikingRecall, memoryContext);
        } catch (_) {
          return openVikingRecall && typeof openVikingRecall === 'object' && !Array.isArray(openVikingRecall)
            ? openVikingRecall
            : {};
        }
      });
  const buildPreparedMainConversationContext = typeof deps.buildPreparedMainConversationContext === 'function'
    ? deps.buildPreparedMainConversationContext
    : (() => null);
  const classifyPromptThreat = typeof deps.classifyPromptThreat === 'function'
    ? deps.classifyPromptThreat
    : (() => ({ labels: [], reasons: [], score: 0 }));
  const getToolPlannerExecutionPlan = typeof deps.getToolPlannerExecutionPlan === 'function'
    ? deps.getToolPlannerExecutionPlan
    : (() => null);
  const isPlannerSingleAuthorityEnabled = typeof deps.isPlannerSingleAuthorityEnabled === 'function'
    ? deps.isPlannerSingleAuthorityEnabled
    : (() => false);
  const normalizePlanForResume = typeof deps.normalizePlanForResume === 'function'
    ? deps.normalizePlanForResume
    : ((plan) => plan || {});
  const normalizeMode = typeof deps.normalizeMode === 'function'
    ? deps.normalizeMode
    : (() => 'chat');
  const ensureOutputStream = typeof deps.ensureOutputStream === 'function'
    ? deps.ensureOutputStream
    : ((output = {}, mode = 'none') => ({ ...(output.stream || {}), mode }));
  const nowTs = typeof deps.nowTs === 'function'
    ? deps.nowTs
    : (() => Date.now());
  const buildLatencyDecision = typeof deps.buildLatencyDecision === 'function'
    ? deps.buildLatencyDecision
    : ((request = {}) => normalizeObject(request.latencyDecision, {}));
  const withSoftTimeout = typeof deps.withSoftTimeout === 'function'
    ? deps.withSoftTimeout
    : (async (task) => task());
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);
  const config = deps.config || {};
  const chatHistory = deps.chatHistory;
  const shortTermMemory = deps.shortTermMemory;
  const runtimeOptions = normalizeObject(deps.runtimeOptions, {});

  function clonePromptBlock(block = {}) {
    if (!block || typeof block !== 'object') return null;
    return {
      ...block,
      content: String(block.content || '').trim(),
      conflictTags: normalizeArray(block.conflictTags),
      meta: block.meta && typeof block.meta === 'object' ? { ...block.meta } : {}
    };
  }

  function normalizePromptBlocks(blocks = []) {
    return normalizeArray(blocks)
      .map(clonePromptBlock)
      .filter((block) => block && String(block.content || '').trim());
  }

  function blockId(block = {}) {
    return String(block?.id || '').trim();
  }

  function pickFirstObject(candidates = []) {
    return normalizeArray(candidates).find((item) => item && typeof item === 'object' && !Array.isArray(item)) || {};
  }

  function resolvePlannerRuntimeMeta(request = {}, promptBuildResult = {}) {
    const routeMeta = normalizeObject(request.routeMeta, {});
    return pickFirstObject([
      promptBuildResult.directChatPlanner,
      promptBuildResult.toolPlanner,
      routeMeta.directChatPlanner,
      routeMeta.toolPlanner
    ]);
  }

  function resolveMemosRecallForObservation(request = {}, promptBuildResult = {}) {
    const routeMeta = normalizeObject(request.routeMeta, {});
    const plannerMeta = resolvePlannerRuntimeMeta(request, promptBuildResult);
    return pickFirstObject([
      promptBuildResult.memosRecall,
      request.memosRecall,
      plannerMeta.memosRecall,
      routeMeta.memosRecall
    ]);
  }

  function resolveOpenVikingRecallForObservation(request = {}, promptBuildResult = {}) {
    const routeMeta = normalizeObject(request.routeMeta, {});
    const plannerMeta = resolvePlannerRuntimeMeta(request, promptBuildResult);
    return pickFirstObject([
      promptBuildResult.openVikingRecall,
      promptBuildResult.openvikingRecall,
      request.openVikingRecall,
      request.openvikingRecall,
      plannerMeta.openVikingRecall,
      plannerMeta.openvikingRecall,
      routeMeta.openVikingRecall,
      routeMeta.openvikingRecall
    ]);
  }

  function resolveDynamicPromptPlanForObservation(request = {}, promptBuildResult = {}) {
    const routeMeta = normalizeObject(request.routeMeta, {});
    const plannerMeta = resolvePlannerRuntimeMeta(request, promptBuildResult);
    return pickFirstObject([
      promptBuildResult.dynamicPromptPlan,
      request.dynamicPromptPlan,
      plannerMeta.dynamicPromptPlan,
      plannerMeta.plannerDecisionV2?.dynamicPromptPlan,
      plannerMeta.plannerDecisionV2?.plannerMeta?.dynamicPromptPlan,
      routeMeta.dynamicPromptPlan
    ]);
  }

  function isMainPromptGuardEnabled(request = {}) {
    return !String(request.customPrompt || '').trim();
  }

  function isAdminPromptRequest(request = {}) {
    const routeMeta = normalizeObject(request.routeMeta, {});
    if (request.isAdmin === true || routeMeta.isAdmin === true || routeMeta.admin === true) return true;
    const userId = String(
      request.userId
      || request.user_id
      || routeMeta.userId
      || routeMeta.user_id
      || routeMeta.senderId
      || routeMeta.sender_id
      || ''
    ).trim();
    if (!userId) return false;
    return normalizeArray(config.ADMIN_USER_IDS)
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .includes(userId);
  }

  function buildDefaultStableSystemBlocks(request = {}) {
    return normalizePromptBlocks(buildMainStableSystemBlocks({
      systemPrompt: config.SYSTEM_PROMPT,
      userId: request.userId,
      routeMeta: request.routeMeta,
      isAdmin: isAdminPromptRequest(request)
    }));
  }

  function ensureMainStableSystemBlocks(blocks = [], request = {}) {
    const stableBlocks = normalizePromptBlocks(blocks);
    if (!isMainPromptGuardEnabled(request)) return stableBlocks;

    const defaults = buildDefaultStableSystemBlocks(request);
    const existingIds = new Set(stableBlocks.map(blockId).filter(Boolean));
    const missingDefaults = defaults.filter((block) => {
      const id = blockId(block);
      return id && !existingIds.has(id);
    });
    return stableBlocks.concat(missingDefaults);
  }

  function blocksToMessages(blocks = []) {
    return normalizePromptBlocks(blocks).map((block) => ({
      role: 'system',
      content: String(block.content || '').trim()
    }));
  }

  function serializePromptBlocks(blocks = []) {
    return normalizePromptBlocks(blocks)
      .map((block) => {
        const label = String(block.label || block.id || 'Prompt Block').trim();
        return `# ${label}\n${String(block.content || '').trim()}`;
      })
      .filter(Boolean)
      .join('\n\n');
  }

  function createFallbackPromptBlock(id, label, content, options = {}) {
    const text = String(content || '').trim();
    if (!text) return null;
    return {
      id: String(id || label || 'fallback_block').trim() || 'fallback_block',
      label: String(label || id || 'Fallback Block').trim() || 'Fallback Block',
      content: text,
      stage: 'main',
      priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : 260,
      authority: String(options.authority || 'memory_fact').trim() || 'memory_fact',
      budgetTokens: Math.max(0, Number(options.budgetTokens || 0) || 0),
      conflictTags: normalizeArray(options.conflictTags),
      kind: String(options.kind || 'memory').trim() || 'memory',
      source: String(options.source || 'prepare_soft_timeout_fallback').trim() || 'prepare_soft_timeout_fallback',
      lane: 'dynamic_context',
      meta: {
        optional: false,
        softTimeoutFallback: true,
        ...(options.meta && typeof options.meta === 'object' ? options.meta : {})
      }
    };
  }

  function summarizeFallbackShortTermContinuity(context = {}) {
    const observation = context?.contextObservability && typeof context.contextObservability === 'object'
      ? context.contextObservability
      : {};
    const profile = context?.contextProfile && typeof context.contextProfile === 'object'
      ? context.contextProfile
      : {};
    return {
      profileName: String(profile.name || '').trim(),
      profileReason: String(profile.reason || '').trim(),
      rawTurnCount: Math.max(0, Number(observation.rawTurnCount || (Array.isArray(context?.recentHistory) ? context.recentHistory.length : 0) || 0) || 0),
      selectedRawTurnCount: Math.max(0, Number(observation.selectedRawTurnCount || (Array.isArray(context?.recentHistory) ? context.recentHistory.length : 0) || 0) || 0),
      selectedNewestRawTurnCount: Math.max(0, Number(observation.selectedNewestRawTurnCount || 0) || 0),
      selectedImportantRawTurnCount: Math.max(0, Number(observation.selectedImportantRawTurnCount || 0) || 0),
      sessionSummaryCount: Math.max(0, Number(observation.sessionSummaryCount || (Array.isArray(context?.recentSessionSummaries) ? context.recentSessionSummaries.length : 0) || 0) || 0),
      shortTermSummaryChars: Math.max(0, Number(observation.shortTermSummaryChars || String(context?.shortTermSummary || '').length || 0) || 0),
      trimReasons: Array.isArray(observation.trimReasons) ? observation.trimReasons.map((item) => String(item || '').trim()).filter(Boolean) : []
    };
  }

  function appendUniquePromptBlock(blocks = [], block = null) {
    if (!block || !String(block.content || '').trim()) return blocks;
    const id = blockId(block);
    if (id && blocks.some((item) => blockId(item) === id)) return blocks;
    blocks.push(block);
    return blocks;
  }

  function resolvePlannerMemosRecall(request = {}) {
    const routeMeta = normalizeObject(request.routeMeta, {});
    const candidates = [
      request.memosRecall,
      routeMeta.directChatPlanner?.memosRecall,
      routeMeta.toolPlanner?.memosRecall,
      routeMeta.memosRecall
    ];
    return pickFirstObject(candidates);
  }

  function resolvePlannerOpenVikingRecall(request = {}) {
    const routeMeta = normalizeObject(request.routeMeta, {});
    const candidates = [
      request.openVikingRecall,
      request.openvikingRecall,
      routeMeta.directChatPlanner?.openVikingRecall,
      routeMeta.directChatPlanner?.openvikingRecall,
      routeMeta.toolPlanner?.openVikingRecall,
      routeMeta.toolPlanner?.openvikingRecall,
      routeMeta.openVikingRecall,
      routeMeta.openvikingRecall
    ];
    return pickFirstObject(candidates);
  }

  function resolvePromptDynamicPlan(request = {}) {
    const routeMeta = normalizeObject(request.routeMeta, {});
    return pickFirstObject([
      request.dynamicPromptPlan,
      routeMeta.directChatPlanner?.dynamicPromptPlan,
      routeMeta.directChatPlanner?.plannerDecisionV2?.dynamicPromptPlan,
      routeMeta.toolPlanner?.dynamicPromptPlan,
      routeMeta.toolPlanner?.plannerDecisionV2?.dynamicPromptPlan,
      routeMeta.dynamicPromptPlan
    ]);
  }

  function planIncludesBlock(plan = {}, targetBlockId = '') {
    const target = String(targetBlockId || '').trim();
    if (!target) return false;
    const enabled = normalizeArray(plan.enabledBlockIds)
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    if (enabled.includes(target)) return true;
    const decision = normalizeArray(plan.blockDecisions)
      .find((item) => String(item?.blockId || '').trim() === target);
    if (!decision) return false;
    return String(decision.decision || '').trim().toLowerCase() !== 'skip';
  }

  function buildFallbackMemoryContext(state = {}, request = {}) {
    const existing = state.memory?.context && typeof state.memory.context === 'object'
      ? state.memory.context
      : null;
    if (existing) return existing;
    if (String(request.customPrompt || '').trim()) return null;
    const routeMeta = normalizeObject(request.routeMeta, {});
    const userId = String(request.userId || '').trim();
    const question = String(request.runtimeQuestionText || request.question || '').trim();
    if (!userId || !question) return null;
    const recallNeed = classifyMemoryNeed(question, {
      facets: request.facets || routeMeta.facets || {},
      intent: request.intent || routeMeta.intent || {},
      meta: routeMeta
    });
    const forceLocalRag = config.MEMORY_RECALL_FORCE_LOCAL_RAG !== false && recallNeed.needsMemory;
    return buildFallbackMemoryContextImpl(userId, question, {
      routePolicyKey: request.routePolicyKey,
      topRouteType: request.topRouteType || routeMeta.topRouteType || '',
      groupId: routeMeta.groupId || routeMeta.group_id || '',
      sessionKey: request.sessionKey || routeMeta.sessionKey || routeMeta.session_key || '',
      sessionId: routeMeta.sessionId || routeMeta.session_id || '',
      taskType: routeMeta.taskType || routeMeta.task_type || '',
      agentName: routeMeta.agentName || routeMeta.agent_name || '',
      toolName: routeMeta.toolName || routeMeta.tool_name || '',
      journalToday: request.journalToday,
      journalNow: request.journalNow,
      dailyJournalTimestamp: request.dailyJournalTimestamp,
      dailyJournalYearMonth: request.dailyJournalYearMonth,
      dailyJournalMaxFourDayFiles: 1,
      dailyJournalMaxMonthlyFiles: 0,
      forceMemoryContext: recallNeed.needsMemory,
      ragEnabled: forceLocalRag ? true : false,
      retrievalPath: forceLocalRag ? 'prepare_fallback_forced_local_rag' : 'prepare_fallback_no_rag'
    }) || null;
  }

  function formatFallbackShortTermContinuity(state = {}, request = {}) {
    const routeMeta = normalizeObject(request.routeMeta, {});
    const context = buildSharedShortTermContextMessagesImpl(request.userId, request.userInfo, {
      chatHistory,
      shortTermMemory,
      routeMeta,
      sessionKey: request.sessionKey || state.thread?.sessionKey,
      routePolicyKey: request.routePolicyKey,
      topRouteType: request.topRouteType,
      question: request.runtimeQuestionText || request.question
    });
    const lines = ['[ShortTermContinuity]'];
    let hasContinuityEvidence = false;
    const sessionKey = String(context?.sessionKey || request.sessionKey || '').trim();
    if (sessionKey) lines.push(`session=${sessionKey}`);
    const summary = String(context?.shortTermSummary || '').trim();
    const meaningfulSummary = summary
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => !/^\[ReplyPosture\]\s*light$/i.test(line));
    const sessionSummaries = normalizeArray(context?.recentSessionSummaries)
      .map((item, index) => {
        const text = String(item?.summary || item?.content || '').replace(/\s+/g, ' ').trim();
        return text ? `${index + 1}. ${text}` : '';
      })
      .filter(Boolean)
      .slice(0, 5);
    if (sessionSummaries.length > 0) {
      hasContinuityEvidence = true;
      lines.push('[RestartRecoverySummaries]');
      lines.push(...sessionSummaries);
    }
    const recentHistory = normalizeArray(context?.recentHistory)
      .map((message) => {
        const role = String(message?.role || '').trim().toLowerCase() === 'assistant' ? 'Assistant' : 'User';
        const content = String(message?.content || '').replace(/\s+/g, ' ').trim();
        return content ? `${role}: ${content}` : '';
      })
      .filter(Boolean)
      .slice(-12);
    if (recentHistory.length > 0) {
      hasContinuityEvidence = true;
      lines.push('[RecentRawTurns]');
      lines.push(...recentHistory);
    }
    if (meaningfulSummary) {
      hasContinuityEvidence = true;
      lines.push(`[StateSummary]\n${summary}`);
    }
    if (!hasContinuityEvidence) return '';
    lines.push('instruction=Use this as high-priority short-term continuity. Prefer exact recent raw turns over vague long-term memory when they conflict.');
    return {
      text: lines.join('\n'),
      meta: summarizeFallbackShortTermContinuity(context)
    };
  }

  function buildSoftTimeoutDynamicBlocks(state = {}, request = {}, memoryContext = null) {
    if (String(request.customPrompt || '').trim()) return [];
    const blocks = normalizePromptBlocks(state.memory?.dynamicContextBlocks);
    const context = memoryContext && typeof memoryContext === 'object' ? memoryContext : {};
    const retrievedText = String(
      context.promptRetrievedMemoryText
      || context.memoryForPrompt
      || context.retrievedMemoryForPrompt
      || ''
    ).trim();
    appendUniquePromptBlock(blocks, createFallbackPromptBlock(
      'retrieved_memory_lite',
      'Retrieved Memory Lite',
      retrievedText ? `[RetrievedMemoryLite]\n${retrievedText}` : '',
      { priority: 260, meta: { evidenceOnly: true } }
    ));

    const dailyJournalText = String(context.promptDailyJournalText || context.dailyJournalText || '').trim();
    appendUniquePromptBlock(blocks, createFallbackPromptBlock(
      'daily_journal',
      'Daily Journal',
      dailyJournalText ? `[DailyJournal]\n${dailyJournalText}` : '',
      { priority: 261, meta: { evidenceOnly: true } }
    ));

    const shortTermContinuity = formatFallbackShortTermContinuity(state, request);
    appendUniquePromptBlock(blocks, createFallbackPromptBlock(
      'short_term_continuity',
      'Short Term Continuity',
      shortTermContinuity.text || shortTermContinuity,
      { priority: 210, kind: 'continuity', meta: { evidenceOnly: true, continuity: shortTermContinuity.meta || {} } }
    ));

    const memosRecall = resolvePlannerMemosRecall(request);
    const dynamicPlan = resolvePromptDynamicPlan(request);
    const shouldInjectMemos = memosRecall.used === true && planIncludesBlock(dynamicPlan, 'memos_recall');
    const memosText = shouldInjectMemos ? String(getMemosRecallPromptTextImpl(memosRecall) || '').trim() : '';
    appendUniquePromptBlock(blocks, createFallbackPromptBlock(
      'memos_recall',
      'MemOS Recall',
      memosText,
      {
        priority: 262,
        source: 'memos_recall',
        meta: { evidenceOnly: true }
      }
    ));

    const openVikingRecall = dedupeOpenVikingRecallImpl(resolvePlannerOpenVikingRecall(request), context);
    const shouldInjectOpenViking = openVikingRecall.used === true && planIncludesBlock(dynamicPlan, 'openviking_recall');
    const openVikingText = shouldInjectOpenViking ? String(getOpenVikingRecallPromptTextImpl(openVikingRecall) || '').trim() : '';
    appendUniquePromptBlock(blocks, createFallbackPromptBlock(
      'openviking_recall',
      'OpenViking Recall',
      openVikingText,
      {
        priority: 263,
        source: 'openviking_recall',
        meta: { evidenceOnly: true }
      }
    ));

    const summaryText = String(context.promptSummaryText || context.summary || '').trim();
    appendUniquePromptBlock(blocks, createFallbackPromptBlock(
      'summary',
      'Summary',
      summaryText ? `[Summary] ${summaryText}` : '',
      { priority: 280, kind: 'summary', meta: { evidenceOnly: true } }
    ));

    return normalizePromptBlocks(blocks);
  }

  function buildGuardedPromptArtifacts(rawResult = {}, request = {}, options = {}) {
    const rawValue = typeof rawResult === 'function' ? rawResult() : rawResult;
    const raw = normalizeObject(rawValue, {});
    const rawStableBlocks = normalizePromptBlocks(raw.stableSystemBlocks);
    const stableSystemBlocks = ensureMainStableSystemBlocks(rawStableBlocks, request);
    const dynamicContextBlocks = normalizePromptBlocks(raw.dynamicContextBlocks);
    const assistantOnlyContextBlocks = normalizePromptBlocks(raw.assistantOnlyContextBlocks);
    const allBlocks = stableSystemBlocks.concat(dynamicContextBlocks, assistantOnlyContextBlocks);
    const freshness = normalizeObject(raw.freshness, {});
    const cacheMeta = normalizeObject(raw.cacheMeta, {});
    const stableGuardApplied = stableSystemBlocks.length > rawStableBlocks.length;

    const existingSnapshot = raw.promptSnapshot && typeof raw.promptSnapshot === 'object'
      ? raw.promptSnapshot
      : null;
    const shouldRebuildSnapshot = stableGuardApplied
      || options.forceGuardApplied
      || !existingSnapshot
      || normalizeArray(existingSnapshot.assembledBlocks).length === 0;
    const compiledSnapshot = shouldRebuildSnapshot
      ? buildPromptSnapshot(allBlocks, {
        stage: 'main',
        policyKey: String(request.routePolicyKey || '').trim() || 'direct_chat/main',
        isAdmin: isAdminPromptRequest(request)
      })
      : null;
    const promptSnapshot = {
      ...(existingSnapshot || {}),
      ...(compiledSnapshot || {}),
      stableBlockIds: stableSystemBlocks.map(blockId).filter(Boolean),
      dynamicBlockIds: dynamicContextBlocks.map(blockId).filter(Boolean),
      assistantOnlyBlockIds: assistantOnlyContextBlocks.map(blockId).filter(Boolean),
      cacheLanes: {
        stable: stableSystemBlocks.map(blockId).filter(Boolean),
        dynamic: dynamicContextBlocks.map(blockId).filter(Boolean),
        assistantOnly: assistantOnlyContextBlocks.map(blockId).filter(Boolean)
      }
    };
    if (Object.keys(freshness).length > 0) promptSnapshot.freshness = freshness;
    if (Object.keys(cacheMeta).length > 0) promptSnapshot.cacheMeta = cacheMeta;
    if (stableGuardApplied) {
      promptSnapshot.runtimeAddedBlocks = normalizeArray(promptSnapshot.runtimeAddedBlocks).concat({
        id: 'stable_system_prompt_guard',
        blockId: 'stable_system_prompt_guard',
        reason: 'main reply stable system blocks were missing during prepare'
      });
    }

    const existingSegments = raw.promptSegments && typeof raw.promptSegments === 'object'
      ? raw.promptSegments
      : {};
    const promptSegments = {
      ...existingSegments,
      systemPrompt: blocksToMessages(stableSystemBlocks.concat(dynamicContextBlocks)),
      assembledBlocks: normalizeArray(promptSnapshot.assembledBlocks).length > 0
        ? promptSnapshot.assembledBlocks
        : allBlocks,
      renderedSystemMessages: normalizeArray(promptSnapshot.renderedSystemMessages).length > 0
        ? promptSnapshot.renderedSystemMessages
        : blocksToMessages(allBlocks),
      tokenUsageByBlock: normalizeArray(promptSnapshot.tokenUsageByBlock),
      trimDecisions: normalizeArray(promptSnapshot.trimDecisions),
      stableSystemBlocks,
      dynamicContextBlocks,
      assistantOnlyContextBlocks
    };
    if (Object.keys(freshness).length > 0) promptSegments.freshness = freshness;
    if (Object.keys(cacheMeta).length > 0) promptSegments.cacheMeta = cacheMeta;

    const dynamicPrompt = String(raw.dynamicPrompt || '').trim()
      || serializePromptBlocks(allBlocks);

    return {
      ...raw,
      dynamicPrompt,
      stableSystemBlocks,
      dynamicContextBlocks,
      assistantOnlyContextBlocks,
      promptSnapshot,
      promptSegments,
      stablePromptGuardApplied: Boolean(options.forceGuardApplied || raw.stablePromptGuardApplied || stableGuardApplied)
    };
  }

  function buildPromptSoftTimeoutFallback(state = {}, request = {}) {
    const memoryContext = buildFallbackMemoryContext(state, request);
    const dynamicContextBlocks = buildSoftTimeoutDynamicBlocks(state, request, memoryContext);
    return buildGuardedPromptArtifacts({
      dynamicPrompt: String(state.memory?.dynamicPrompt || ''),
      stableSystemBlocks: normalizeArray(state.memory?.stableSystemBlocks),
      dynamicContextBlocks,
      assistantOnlyContextBlocks: normalizeArray(state.memory?.assistantOnlyContextBlocks),
      affinity: state.memory?.affinity || null,
      memoryContext: memoryContext || null,
      personaMemoryState: state.memory?.personaMemoryState || null,
      promptSnapshot: state.memory?.promptSnapshot || null,
      promptSegments: state.memory?.promptSegments || null,
      freshness: {
        stableSystem: 'fallback',
        sessionContext: 'partial',
        continuity: 'skipped'
      },
      cacheMeta: {
        stableKey: '',
        sessionKey: '',
        hit: false
      },
      criticalBlocks: [],
      optionalBlocks: [],
      latencyMeta: {
        essentialDurationMs: 0,
        optionalDurationMs: 0,
        optionalBuildEnabled: false,
        optionalBudgetMs: 0,
        optionalBudgetExceeded: false
      }
    }, request, { forceGuardApplied: true });
  }

  return async function prepareNode(state) {
    const startedAt = nowTs();
    const request = normalizeObject(state.request, {});
    const routeMeta = normalizeObject(request.routeMeta, {});
    const requestQuestionText = String(request.runtimeQuestionText || request.question || '').trim();
    const persistUserText = String(request.persistUserText || request.runtimeQuestionText || request.question || '').trim();
    const threadId = String(state.thread?.threadId || '').trim();
    const latencyDecision = buildLatencyDecision(request, state.execution?.latencyDecision || {});
    const memoryContextMemo = new Map();
    const events = [createEvent('node_start', { node: 'prepare', threadId })];

    let resumeUsed = false;
    let restored = null;
    if (request.resumePolicy !== 'fresh') {
      restored = loadCheckpoint(threadId);
      if (restored && restored.state && String(restored.status || '').trim() !== 'completed') {
        resumeUsed = true;
      }
    }

    const shouldExposeMemoryCliInPrepare = shouldExposeMemoryCli({
      ...request,
      customPrompt: request.customPrompt,
      disableTools: !request.allowTools,
      memoryCliTurn: state.execution?.memoryCliTurn
    });

    if (shouldExposeMemoryCliInPrepare) {
      recordMemoryScope(request.userId, routeMeta);
    }

    let bridgeRestored = false;
    if (
      !request.systemInitiated
      && !String(request.customPrompt || '').trim()
      && String(request.userId || '').trim()
      && persistUserText
    ) {
      const bridgeRestore = restoreShortTermBridgeAfterRestartIfNeeded(request.userId, {
        chatHistory,
        shortTermMemory,
        routeMeta,
        sessionKey: request.sessionKey
      });
      bridgeRestored = Boolean(bridgeRestore.restored);
      if (!bridgeRestore.restored) {
        rehydrateShortTermMemoryAfterRestartIfNeeded(request.userId, persistUserText, request.userInfo, {
          chatHistory,
          shortTermMemory,
          routeMeta,
          sessionKey: request.sessionKey
        });
      }
    }

    if (
      isChatLikeRoute(request)
      && !request.systemInitiated
      && !String(request.customPrompt || '').trim()
      && String(request.userId || '').trim()
      && typeof summarizeShortTermChunk === 'function'
    ) {
      await withSoftTimeout(
        () => compressShortTermHistoryIfNeeded(request.userId, request.userInfo, {
          chatHistory,
          shortTermMemory,
          routeMeta,
          sessionKey: request.sessionKey,
          summarizeChunk: (payload = {}) => summarizeShortTermChunk({
            ...payload,
            request
          })
        }),
        latencyDecision.memoryBudgetMs,
        { compressed: false }
      );
    }

    const restoredState = resumeUsed ? normalizeObject(restored?.state, {}) : {};

    if (
      config.SHORT_TERM_PENDING_SNAPSHOT_ENABLED
      && !request.systemInitiated
      && String(request.userId || '').trim()
      && persistUserText
      && !String(request.customPrompt || '').trim()
      && isChatLikeRoute(request)
    ) {
      persistShortTermBridgeSnapshot(request.userId, {
        chatHistory,
        shortTermMemory,
        routeMeta,
        sessionKey: request.sessionKey,
        scope: state.thread?.sessionScope,
        snapshotType: 'pre_reply',
        shortTermState: {
          carryOverUserTurn: persistUserText || (request.imageUrl ? '[shared an image]' : '')
        }
      });
      events.push(createEvent('checkpoint', {
        node: 'prepare',
        stage: 'pre_reply',
        threadId
      }));
    }

    const restoredExecution = normalizeObject(restoredState.execution, state.execution);
    const nextMemoryCliTurn = createMemoryCliTurnState(restoredExecution.memoryCliTurn);
    const effectiveAllowedTools = computeEffectiveAllowedTools(request, nextMemoryCliTurn);
    const globalPreflight = {
      skipped: true,
      reason: 'deferred_to_dispatch',
      results: [],
      evidenceMessage: '',
      memoryCliTurn: nextMemoryCliTurn
    };
    const preflightMemoryCliTurn = createMemoryCliTurnState(nextMemoryCliTurn);
    const executionMemoryCliTurn = createMemoryCliTurnState(nextMemoryCliTurn);
    const executionAllowedTools = computeEffectiveAllowedTools(request, executionMemoryCliTurn);
    const threatMeta = classifyPromptThreat(requestQuestionText || '', {
      routePolicyKey: request.routePolicyKey,
      topRouteType: request.topRouteType
    });

    const promptBuildResult = await withSoftTimeout(
      () => buildDynamicPromptImpl(
        request.userInfo,
        request.userId,
        requestQuestionText,
        request.customPrompt,
        {
          routePrompt: request.routePrompt,
          routePolicyKey: request.routePolicyKey,
          topRouteType: request.topRouteType,
          reviewMode: request.reviewMode,
          routeMeta: request.routeMeta,
          customPrompt: request.customPrompt,
          disableTools: !request.allowTools,
          modelConfig: request.modelConfig,
          memoryCliTurn: executionMemoryCliTurn,
          securityLabels: normalizeArray(threatMeta.labels),
          chatHistory,
          shortTermMemory,
          sessionKey: request.sessionKey,
          latencyDecision,
          __memoryContextMemo: memoryContextMemo
        }
      ),
      latencyDecision.prepareSoftBudgetMs,
      () => buildPromptSoftTimeoutFallback(state, request)
    );
    const guardedPromptBuildResult = buildGuardedPromptArtifacts(promptBuildResult, request);
    const {
      dynamicPrompt,
      stableSystemBlocks,
      dynamicContextBlocks,
      assistantOnlyContextBlocks,
      affinity,
      memoryContext,
      personaMemoryState,
      promptSnapshot,
      promptSegments,
      latencyMeta,
      stablePromptGuardApplied
    } = guardedPromptBuildResult;
    recordMainPromptBlockObservation({
      requestTrace: request.requestTrace || request.routeMeta?.requestTrace || null,
      routeMeta: request.routeMeta,
      routePolicyKey: request.routePolicyKey,
      topRouteType: request.topRouteType,
      userId: request.userId,
      promptSnapshot,
      memoryContext,
      memosRecall: resolveMemosRecallForObservation(request, guardedPromptBuildResult),
      openVikingRecall: resolveOpenVikingRecallForObservation(request, guardedPromptBuildResult),
      dynamicPromptPlan: resolveDynamicPromptPlanForObservation(request, guardedPromptBuildResult),
      stage: 'prepare_main_prompt_blocks'
    });
    const continuityProbe = await withSoftTimeout(
      () => maybeRunAutoContinuityProbe({
        ...state,
        memory: {
          ...state.memory,
          context: memoryContext || null
        },
        execution: {
          ...state.execution,
          memoryCliTurn: executionMemoryCliTurn,
          latencyDecision
        }
      }),
      latencyDecision.continuityBudgetMs,
      {
        skipped: true,
        reason: 'soft_timeout',
        events: [createEvent('continuity_probe_skipped', { node: 'prepare', reason: 'soft_timeout' })],
        probeResult: null,
        probeMeta: null
      }
    );
    const continuityBuilt = buildContinuityState({
      request,
      thread: state.thread,
      shortTermMemory,
      chatHistory,
      memoryContext: memoryContext || null,
      continuityProbeResult: continuityProbe.probeResult,
      maxChars: config.CONTINUITY_STATE_PROMPT_MAX_CHARS
    });
    const preparedMainConversationContext = buildPreparedMainConversationContext({
      ...state,
      request: {
        ...normalizeObject(restoredState.request, {}),
        ...state.request,
        allowedTools: executionAllowedTools
      },
      memory: {
        ...normalizeObject(restoredState.memory, state.memory),
        dynamicPrompt,
        stableSystemBlocks: normalizeArray(stableSystemBlocks),
        dynamicContextBlocks: normalizeArray(dynamicContextBlocks),
        assistantOnlyContextBlocks: normalizeArray(assistantOnlyContextBlocks),
        promptSnapshot: promptSnapshot || null,
        promptSegments: promptSegments || null,
        affinity,
        context: memoryContext || null,
        personaMemoryState: personaMemoryState || null,
        continuityState: {
          payload: continuityBuilt.payload,
          text: continuityBuilt.text,
          probe: continuityProbe.probeMeta
            ? {
                facet: continuityProbe.probeMeta.facet,
                skipped: Boolean(continuityProbe.skipped),
                reason: continuityProbe.reason
              }
            : null,
          hasSufficientEvidence: continuityBuilt.hasSufficientEvidence
        }
      },
      execution: {
        ...restoredExecution,
        memoryCliTurn: executionMemoryCliTurn
      }
    });

    const nextState = {
      ...state,
      request: {
        ...normalizeObject(restoredState.request, {}),
        ...state.request,
        allowedTools: executionAllowedTools
      },
      thread: {
        ...normalizeObject(restoredState.thread, state.thread),
        ...state.thread,
        checkpointStatus: resumeUsed ? 'resumed' : 'fresh',
        resumeUsed,
        currentNode: 'prepare',
        updatedAt: nowTs()
      },
      memory: {
        ...normalizeObject(restoredState.memory, state.memory),
        dynamicPrompt,
        stableSystemBlocks: normalizeArray(stableSystemBlocks),
        dynamicContextBlocks: normalizeArray(dynamicContextBlocks),
        assistantOnlyContextBlocks: normalizeArray(assistantOnlyContextBlocks),
        promptSnapshot: promptSnapshot || null,
        promptSegments: promptSegments || null,
        securityLabels: normalizeArray(threatMeta.labels),
        blockedLearningEvents: normalizeArray(restoredState.memory?.blockedLearningEvents),
        redactionEvents: normalizeArray(restoredState.memory?.redactionEvents),
        affinity,
        context: memoryContext || null,
        personaMemoryState: personaMemoryState || null,
        dirty: false,
        restoredBridge: bridgeRestored,
        memoryScopeRecorded: shouldExposeMemoryCliInPrepare,
        persisted: false,
        globalToolEvidence: String(globalPreflight?.evidenceMessage || '').trim(),
        globalToolResults: normalizeArray(globalPreflight?.results).map((item) => ({ ...normalizeObject(item, {}) })),
        globalToolMemoryCliTurn: preflightMemoryCliTurn,
        continuityState: {
          payload: continuityBuilt.payload,
          text: continuityBuilt.text,
          probe: continuityProbe.probeMeta
            ? {
                facet: continuityProbe.probeMeta.facet,
                skipped: Boolean(continuityProbe.skipped),
                reason: continuityProbe.reason
              }
            : null,
          hasSufficientEvidence: continuityBuilt.hasSufficientEvidence
        },
        preparedMainConversationContext: preparedMainConversationContext || null,
        mainConversationMessages: normalizeArray(preparedMainConversationContext?.messages),
        assistantOnlyContextMessagesPrepared: normalizeArray(preparedMainConversationContext?.assistantOnlyContextMessages),
        canonicalSegmentsPrepared: preparedMainConversationContext?.canonicalSegments || null,
        compactionPlanPrepared: preparedMainConversationContext?.compactionPlan || null,
        mainConversationSnapshot: preparedMainConversationContext?.mainConversationSnapshot || null,
        contextStats: preparedMainConversationContext?.contextStats || null,
        mainConversationSnapshotSignature: String(preparedMainConversationContext?.signature || '').trim()
      },
      plan: resumeUsed
        ? normalizePlanForResume({
            ...state.plan,
            ...normalizeObject(restoredState.plan, {})
          })
        : state.plan,
      execution: {
        ...restoredExecution,
        mode: resumeUsed && String(restoredState.execution?.mode || '').trim()
          ? String(restoredState.execution.mode).trim()
          : normalizeMode(request),
        currentNode: 'prepare',
        resumedFromNode: resumeUsed ? String(restored?.node || '').trim() : '',
        retryQueue: normalizeArray(restoredState.execution?.retryQueue),
        memoryCliTurn: executionMemoryCliTurn,
        latencyDecision,
        cacheStats: {
          ...normalizeObject(restoredState.execution?.cacheStats, state.execution?.cacheStats),
          promptCacheHit: Boolean(promptSnapshot?.cacheMeta?.hit || promptSegments?.cacheMeta?.hit),
          memoryCacheHit: Boolean(memoryContext?.cacheMeta?.hit),
          toolCacheHitCount: Number(restoredState.execution?.cacheStats?.toolCacheHitCount || 0) || 0
        },
        latencyBreakdown: {
          ...normalizeObject(restoredState.execution?.latencyBreakdown, state.execution?.latencyBreakdown),
          prepare: {
            durationMs: Math.max(0, nowTs() - startedAt),
            timedOut: Boolean(String(promptSnapshot?.freshness?.sessionContext || promptSegments?.freshness?.sessionContext || '').trim() === 'partial'),
            deferred: true,
            prompt_build_essential_ms: Number(latencyMeta?.essentialDurationMs || 0) || 0,
            prompt_build_optional_ms: Number(latencyMeta?.optionalDurationMs || 0) || 0,
            prompt_collect_ms: Number(latencyMeta?.promptCollectMs || 0) || 0,
            prompt_render_ms: Number(latencyMeta?.promptRenderMs || 0) || 0,
            mcp_warm_wait_ms: 0
          }
        }
      },
      output: resumeUsed && restoredState.output
        ? {
            ...state.output,
            ...normalizeObject(restoredState.output, {}),
            stream: {
              ...ensureOutputStream(state.output),
              ...ensureOutputStream(normalizeObject(restoredState.output, {}), state.output?.stream?.mode || 'none')
            }
          }
        : {
            ...state.output,
            stream: ensureOutputStream(state.output)
          }
    };

    const nextEvents = events.concat([
      ...normalizeArray(continuityProbe.events),
      createEvent('prompt_security_labels', {
        node: 'prepare',
        labels: normalizeArray(threatMeta.labels),
        score: Number(threatMeta.score || 0) || 0
      }),
      createEvent('continuity_state_built', {
        node: 'prepare',
        hasText: Boolean(String(continuityBuilt.text || '').trim()),
        sourceFlags: normalizeArray(continuityBuilt.payload?.source_flags)
      }),
      createEvent('effectiveAllowedTools', {
        node: 'prepare',
        allowedTools: executionAllowedTools,
        routeAllowedTools: normalizeArray(request.routeMeta?.allowedTools),
        memoryNeedReason: request.routeMeta?.meta?.needsMemoryReason || request.routeMeta?.needsMemoryReason || '',
        memoryToolGateReason: normalizeArray(executionAllowedTools).includes('memory_cli')
          ? 'memory_cli_allowed'
          : 'memory_cli_not_allowed'
      }),
      createEvent('latency_profile', {
        node: 'prepare',
        profile: latencyDecision.profile,
        deferPersist: Boolean(latencyDecision.deferPersist)
      }),
      createEvent('memoryCliTurn', {
        node: 'prepare',
        memoryCliTurn: executionMemoryCliTurn
      }),
      ...(stablePromptGuardApplied ? [createEvent('prompt_stable_guard_applied', {
        node: 'prepare',
        stableBlockIds: normalizeArray(stableSystemBlocks).map((block) => String(block?.id || '').trim()).filter(Boolean)
      })] : []),
      createEvent('checkpoint', { node: 'prepare', resumeUsed, threadId }),
      createEvent('node_complete', { node: 'prepare', threadId })
    ]);

    return saveAndEmit({
      ...nextState,
      events: nextEvents
    }, 'prepare', 'running', nextEvents);
  };
}

module.exports = {
  createPrepareNode
};

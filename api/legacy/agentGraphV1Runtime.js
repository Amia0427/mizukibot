const config = require('../../config');
// Archived V1 runtime. Keep this file for regression/reference only; new
// orchestration work belongs in agentGraphV2 and neutral helper modules.
const { StateGraph, END } = require('@langchain/langgraph');
const { AIMessage } = require('@langchain/core/messages');
const { ChatOpenAI } = require('@langchain/openai');
const { askAIByGraphV2 } = require('../agentGraphV2');
const { normalizeToolNames } = require('../../utils/localToolAccess');

function getToolRegistry() {
  return require('../toolRegistry');
}

function getToolExecutors() {
  return getToolRegistry().getToolExecutors();
}

function getToolSchemas() {
  return getToolRegistry().getToolSchemas();
}
const { postWithRetry } = require('../httpClient');
const { extractMessageContent } = require('../parser');

function getMainReplyDefaultMaxTokens() {
  return Math.max(64, Number(config.MAIN_REPLY_DEFAULT_MAX_TOKENS || 8192) || 8192);
}

const { chatHistory, shortTermMemory, addProfileItem, buildReplyStylePolicy } = require('../../utils/memory');
const { buildMemoryContext, buildMemoryContextAsync } = require('../../utils/memoryContext');
const { HUMANIZER_SYSTEM_PROMPT } = require('../../utils/humanizer');
const { runHumanizerAgent, isHumanizerAgentEnabled } = require('../humanizerAgent');
const { buildDynamicFewShotPrompt } = require('../../utils/fewShotPrompts');
const { buildRuntimePrompt } = require('../../utils/runtimePrompts');
const { learnSomethingNew } = require('../memoryExtraction');
const {
  compressShortTermHistoryIfNeeded,
  buildShortTermContextMessages,
  appendShortTermHistory,
  rehydrateShortTermMemoryAfterRestartIfNeeded,
  resolveShortTermSessionKey,
  resolveShortTermScope,
  buildStructuredCompressionPrompt
} = require('../../utils/shortTermMemory');
const {
  restoreShortTermBridgeAfterRestartIfNeeded,
  persistShortTermBridgeSnapshot
} = require('../../utils/shortTermBridgeMemory');
const {
  buildMemoryCliFollowupInstruction,
  createMemoryCliTurnState,
  decideMemoryCliTurnAction,
  filterAllowedToolsForMemoryCliTurn,
  getMemoryCliTurnPromptKey,
  normalizeMemoryCliTurnState,
  updateMemoryCliTurnStateAfterError,
  updateMemoryCliTurnStateAfterResult
} = require('../../utils/memoryCliTurnPolicy');
const { classifyReplyFailure, isReplyFailure } = require('../../utils/replyFailure');
const {
  estimateMessagesTokens,
  estimateTokens,
  getAffinitySettings,
  trimMessagesByTokenBudget,
  trimTextByTokenBudget
} = require('../../utils/contextBudget');
const { isToolSchemaValidationError } = require('../../utils/modelCompat');
const { getPolicy, enforceToolPolicy } = require('../../utils/toolPolicy');
const { getApiProvider } = require('../../utils/modelProvider');
const { shouldUseMinecraftLLM, getMinecraftModelOverrides } = require('../../utils/minecraftRouting');
const {
  resolveForcedFallbackMainModelConfig,
  recordMainModelFailure,
  recordMainModelSuccess
} = require('../../utils/mainModelFallback');
const {
  startModelCall,
  finishModelCall,
  failModelCall
} = require('../../utils/modelCallTracker');
const { appendDailyJournalEntry } = require('../../utils/dailyJournal');
const { recordMemoryScope } = require('../../utils/memoryScopeIndex');
const {
  resolveRoleAwareMainModelConfig,
  resolveUserScopedMainModelConfig,
  shouldBypassMainModelFallback
} = require('../../utils/mainModelConfigResolver');

function getBaseURLForOpenAI() {
  const raw = String(config.API_BASE_URL || '').replace(/\/+$/, '');
  return raw.replace(/\/chat\/completions$/i, '');
}

function getDefaultClientHeaders() {
  return {
    'User-Agent': String(config.HTTP_USER_AGENT || config.CODEX_USER_AGENT).trim(),
    'Accept-Language': String(config.HTTP_ACCEPT_LANGUAGE || 'zh-CN,zh;q=0.9,en;q=0.8').trim()
  };
}

function normalizeMainModelConfig(overrides = null, userId = '', options = {}) {
  return resolveUserScopedMainModelConfig(userId, overrides, options);
}

function getCurrentMainModelConfig(userId = '', options = {}) {
  return normalizeMainModelConfig(null, userId, options);
}

function createGraphModelClient({ apiBaseUrl, apiKey, model, temperature, topP, timeoutMs, retries }) {
  const provider = getApiProvider(apiBaseUrl, model);
  if (provider === 'anthropic') {
    const anthropicCompatibleClient = {
      // Anthropic compatibility path already records actual HTTP calls inside postWithRetry.
      // Mark it so graph-level invoke wrappers do not create duplicate model-call records.
      __tracksHttpInternally: true,
      async invoke(messages, options = {}) {
        const resp = await postWithRetry(
          String(apiBaseUrl || '').trim(),
          {
            model,
            temperature,
            top_p: topP,
            messages,
            tools: Array.isArray(options.tools) ? options.tools : [],
            tool_choice: options.tool_choice,
            max_tokens: Math.max(64, Number(config.AI_MAX_TOKENS) || getMainReplyDefaultMaxTokens()),
            stream: false
          },
          retries,
          apiKey
        );

        const msg = extractMessageContent(resp);
        return new AIMessage({
          content: safeReadMessageText(msg),
          tool_calls: Array.isArray(msg?.tool_calls)
            ? msg.tool_calls.map((call) => ({
                id: call.id,
                name: call?.function?.name || call?.name,
                args: (() => {
                  try {
                    return JSON.parse(call?.function?.arguments || '{}');
                  } catch (_) {
                    return {};
                  }
                })()
              }))
            : [],
          response_metadata: {
            model_name: resp?.data?.model || model
          }
        });
      }
    };
    return anthropicCompatibleClient;
  }

  return new ChatOpenAI({
    apiKey,
    model,
    temperature,
    topP,
    timeout: timeoutMs,
    maxRetries: retries,
    configuration: {
      baseURL: String(apiBaseUrl || '').replace(/\/chat\/completions$/i, ''),
      defaultHeaders: getDefaultClientHeaders()
    }
  });
}

function shouldTrackGraphInvoke(client) {
  return !Boolean(client && client.__tracksHttpInternally);
}

function shouldMergeSystemMessagesForProvider(apiBaseUrl, model) {
  return getApiProvider(apiBaseUrl, model) === 'anthropic';
}

function mergeSystemMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const mergedSystem = [];
  const output = [];

  for (const item of list) {
    const role = String(item?.role || '').toLowerCase();
    if (role === 'system') {
      const text = safeReadMessageText(item).trim();
      if (text) mergedSystem.push(text);
      continue;
    }
    output.push(item);
  }

  if (mergedSystem.length > 0) {
    output.unshift({
      role: 'system',
      content: mergedSystem.join('\n\n')
    });
  }

  return output;
}

function getChatCompletionsUrl() {
  const raw = String(config.API_BASE_URL || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return raw;
}

function getMemoryChatCompletionsUrl() {
  const raw = String(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return raw;
}

function getMemoryModelName() {
  return String(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function getMemoryApiKey() {
  if (String(config.MEMORY_API_BASE_URL || '').trim()) {
    return String(config.MEMORY_API_KEY || config.API_KEY || '').trim();
  }
  return String(config.API_KEY || '').trim();
}

function getToolsChatCompletionsUrl() {
  const raw = String(config.TOOLS_API_BASE_URL || config.API_BASE_URL || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return raw;
}

function getToolsModelName() {
  return String(config.TOOLS_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function getToolsApiKey() {
  if (String(config.TOOLS_API_BASE_URL || '').trim()) {
    return String(config.TOOLS_API_KEY || config.API_KEY || '').trim();
  }
  return String(config.API_KEY || '').trim();
}

function createInitialState({
  question,
  userInfo,
  userId,
  sessionKey = '',
  customPrompt = null,
  routePrompt = null,
  routePolicyKey = null,
  topRouteType = null,
  reviewMode = null,
  routeMeta = null,
  imageUrl = null,
  streaming = false,
  allowTools = true,
  allowedTools = null
}) {
  return {
    question: question || '',
    userInfo: userInfo || { level: 'stranger' },
    userId: String(userId || ''),
    sessionKey: String(sessionKey || resolveShortTermSessionKey(userId, routeMeta) || '').trim(),
    customPrompt,
    routePrompt: String(routePrompt || '').trim(),
    routePolicyKey: String(routePolicyKey || '').trim(),
    topRouteType: String(topRouteType || routeMeta?.topRouteType || '').trim(),
    reviewMode: String(reviewMode || '').trim(),
    routeMeta: routeMeta && typeof routeMeta === 'object' ? routeMeta : null,
    imageUrl,
    streaming: Boolean(streaming),
    allowTools: Boolean(allowTools),
    allowedTools: normalizeToolNames(allowedTools),
    planRuntime: createPlanRuntime(routePolicyKey, routeMeta),
    toolLoopCount: 0,
    memoryCliTurn: createMemoryCliTurnState(),
    dynamicPromptCache: null,
    messages: [],
    finalReply: ''
  };
}

function normalizePlanStepRuntime(step = {}, index = 0) {
  return {
    step: String(step?.step || `step_${index + 1}`).trim(),
    instruction: String(step?.instruction || '').trim(),
    preferredTools: Array.isArray(step?.preferredTools)
      ? step.preferredTools.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)
      : [],
    required: Array.isArray(step?.required)
      ? step.required.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)
      : [],
    produces: String(step?.produces || '').trim(),
    successCheck: String(step?.successCheck || '').trim(),
    optional: Boolean(step?.optional),
    status: String(step?.status || 'pending').trim() || 'pending',
    attemptCount: Number.isFinite(Number(step?.attemptCount)) ? Number(step.attemptCount) : 0,
    matchedTools: Array.isArray(step?.matchedTools)
      ? Array.from(new Set(step.matchedTools.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)))
      : [],
    lastToolName: String(step?.lastToolName || '').trim(),
    lastResultPreview: String(step?.lastResultPreview || '').trim(),
    completionSource: String(step?.completionSource || '').trim(),
    updatedAt: Number.isFinite(Number(step?.updatedAt)) ? Number(step.updatedAt) : 0
  };
}

function createPlanRuntime(routePolicyKey = '', routeMeta = null) {
  const meta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  const planId = String(meta.planId || '').trim();
  const planSteps = Array.isArray(meta.planSteps) ? meta.planSteps : [];
  if (!planId || !planSteps.length) return null;

  return {
    planId,
    routePolicyKey: String(routePolicyKey || '').trim(),
    status: 'pending',
    startedAt: Date.now(),
    finishedAt: 0,
    currentStep: String(planSteps[0]?.step || '').trim(),
    stepCount: planSteps.length,
    unmatchedTools: [],
    steps: planSteps.map((step, index) => normalizePlanStepRuntime(step, index))
  };
}

function normalizePlanRuntime(planRuntime = null, routePolicyKey = '') {
  if (!planRuntime || typeof planRuntime !== 'object') return null;
  const steps = Array.isArray(planRuntime.steps) ? planRuntime.steps : [];
  if (!steps.length) return null;

  return {
    planId: String(planRuntime.planId || '').trim(),
    routePolicyKey: String(planRuntime.routePolicyKey || routePolicyKey || '').trim(),
    status: String(planRuntime.status || 'pending').trim() || 'pending',
    startedAt: Number.isFinite(Number(planRuntime.startedAt)) ? Number(planRuntime.startedAt) : 0,
    finishedAt: Number.isFinite(Number(planRuntime.finishedAt)) ? Number(planRuntime.finishedAt) : 0,
    currentStep: String(planRuntime.currentStep || '').trim(),
    stepCount: Number.isFinite(Number(planRuntime.stepCount)) ? Number(planRuntime.stepCount) : steps.length,
    unmatchedTools: Array.isArray(planRuntime.unmatchedTools)
      ? Array.from(new Set(planRuntime.unmatchedTools.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)))
      : [],
    steps: steps.map((step, index) => normalizePlanStepRuntime(step, index))
  };
}

function summarizePlanRuntime(planRuntime = null) {
  if (!planRuntime) return null;
  const unmatchedTools = Array.isArray(planRuntime.unmatchedTools)
    ? Array.from(new Set(planRuntime.unmatchedTools.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)))
    : [];
  return {
    planId: String(planRuntime.planId || '').trim(),
    routePolicyKey: String(planRuntime.routePolicyKey || '').trim(),
    status: String(planRuntime.status || '').trim(),
    currentStep: String(planRuntime.currentStep || '').trim(),
    stepCount: Array.isArray(planRuntime.steps) ? planRuntime.steps.length : 0,
    steps: Array.isArray(planRuntime.steps)
      ? planRuntime.steps.map((step) => ({
          step: step.step,
          status: step.status,
          attemptCount: step.attemptCount,
          matchedTools: step.matchedTools
        }))
      : [],
    unmatchedTools
  };
}

function getToolResultStatus(toolResult = '') {
  const text = String(toolResult || '').trim();
  if (!text) return 'failed';
  if (text.startsWith('Unknown tool:')) return 'failed';
  if (text.startsWith('Tool error:')) return 'failed';
  if (text.startsWith('Tool not allowed:')) return 'failed';
  return 'completed';
}

function findPlanStepIndexForTool(planRuntime = null, toolName = '') {
  if (!planRuntime || !Array.isArray(planRuntime.steps)) return -1;
  const normalizedTool = String(toolName || '').trim();
  if (!normalizedTool) return -1;

  const exactMatch = planRuntime.steps.findIndex((step) => (
    ['pending', 'in_progress', 'failed'].includes(String(step?.status || ''))
    && Array.isArray(step?.preferredTools)
    && step.preferredTools.includes(normalizedTool)
  ));
  if (exactMatch >= 0) return exactMatch;

  const completedMatch = planRuntime.steps.findIndex((step) => (
    String(step?.status || '') === 'completed'
    && Array.isArray(step?.preferredTools)
    && step.preferredTools.includes(normalizedTool)
  ));
  if (completedMatch >= 0) return completedMatch;

  return -1;
}

function completeLeadingNonToolSteps(planRuntime = null, stopIndex = -1, completionSource = 'planner_transition') {
  if (!planRuntime || !Array.isArray(planRuntime.steps)) return planRuntime;
  const runtime = {
    ...planRuntime,
    steps: planRuntime.steps.map((step) => ({ ...step }))
  };

  for (let index = 0; index < stopIndex; index += 1) {
    const step = runtime.steps[index];
    if (!step || step.status !== 'pending') continue;
    if (Array.isArray(step.preferredTools) && step.preferredTools.length > 0) continue;

    runtime.steps[index] = {
      ...step,
      status: 'completed',
      completionSource,
      updatedAt: Date.now()
    };
  }

  return runtime;
}

function updatePlanRuntimeCurrentStep(planRuntime = null) {
  if (!planRuntime || !Array.isArray(planRuntime.steps)) return planRuntime;
  const nextStep = planRuntime.steps.find((step) => ['pending', 'in_progress', 'failed'].includes(String(step?.status || '')));
  return {
    ...planRuntime,
    currentStep: nextStep ? String(nextStep.step || '').trim() : ''
  };
}

function recordPlanRuntimeToolResult(planRuntime = null, toolName = '', toolResult = '', runtimeStatus = '') {
  if (!planRuntime) return null;

  const matchedIndex = findPlanStepIndexForTool(planRuntime, toolName);
  const runtime = completeLeadingNonToolSteps(planRuntime, matchedIndex);
  const nextRuntime = {
    ...runtime,
    status: runtime.status === 'pending' ? 'running' : runtime.status,
    steps: runtime.steps.map((step) => ({ ...step })),
    unmatchedTools: Array.isArray(runtime.unmatchedTools) ? [...runtime.unmatchedTools] : []
  };
  const normalizedRuntimeStatus = String(runtimeStatus || '').trim().toLowerCase();
  const resultStatus = normalizedRuntimeStatus === 'blocked'
    ? 'failed'
    : getToolResultStatus(toolResult);
  const preview = String(toolResult || '').trim().slice(0, 160);

  if (matchedIndex < 0) {
    const unmatchedToolName = String(toolName || '').trim();
    if (unmatchedToolName && !nextRuntime.unmatchedTools.includes(unmatchedToolName)) {
      nextRuntime.unmatchedTools.push(unmatchedToolName);
    }
    return updatePlanRuntimeCurrentStep(nextRuntime);
  }

  const current = nextRuntime.steps[matchedIndex];
  nextRuntime.steps[matchedIndex] = {
    ...current,
    status: resultStatus,
    attemptCount: Number(current.attemptCount || 0) + 1,
    matchedTools: Array.from(new Set([...(current.matchedTools || []), String(toolName || '').trim()].filter(Boolean))),
    lastToolName: String(toolName || '').trim(),
    lastResultPreview: preview,
    completionSource: resultStatus === 'completed' ? 'tool_result' : 'tool_error',
    updatedAt: Date.now()
  };

  return updatePlanRuntimeCurrentStep(nextRuntime);
}

function finalizePlanRuntime(planRuntime = null, finalReply = '') {
  if (!planRuntime) return null;
  const runtime = {
    ...planRuntime,
    steps: Array.isArray(planRuntime.steps) ? planRuntime.steps.map((step) => ({ ...step })) : []
  };
  const hasUsableReply = !looksLikeFailureReply(finalReply);

  if (hasUsableReply) {
    runtime.steps = runtime.steps.map((step) => {
      if (step.status === 'pending' && (!Array.isArray(step.preferredTools) || step.preferredTools.length === 0)) {
        return {
          ...step,
          status: 'completed',
          completionSource: 'final_reply',
          updatedAt: Date.now()
        };
      }
      if (step.status === 'pending' && step.optional) {
        return {
          ...step,
          status: 'skipped',
          completionSource: 'final_reply',
          updatedAt: Date.now()
        };
      }
      return step;
    });
  }

  const hasFailedRequiredStep = runtime.steps.some((step) => step.status === 'failed' && !step.optional);
  const hasPendingRequiredStep = runtime.steps.some((step) => step.status === 'pending' && !step.optional);
  runtime.status = hasUsableReply
    ? (hasFailedRequiredStep || hasPendingRequiredStep ? 'partial' : 'completed')
    : 'failed';
  runtime.finishedAt = Date.now();

  return updatePlanRuntimeCurrentStep(runtime);
}

function safeReadMessageText(msg) {
  if (!msg) return '';
  const content = msg.content;

  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }

  if (typeof msg.text === 'string') return msg.text;
  return '';
}

function getRecentChatHistory(userId, userInfo = {}, options = {}) {
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const sessionKey = String(options?.sessionKey || resolveShortTermSessionKey(userId, routeMeta) || '').trim();
  const context = buildShortTermContextMessages(userId, userInfo, {
    chatHistory,
    shortTermMemory,
    routeMeta,
    sessionKey
  });
  return {
    summaryMessage: context.summaryMessage,
    history: context.recentHistory,
    affinity: context.affinity,
    sessionKey: context.sessionKey
  };
}

async function buildDynamicPrompt(state) {
  const routeMeta = state.routeMeta && typeof state.routeMeta === 'object' ? state.routeMeta : {};
  const affinity = getAffinitySettings(state.userInfo, {
    userId: state.userId,
    chatType: routeMeta.chatType || routeMeta.chat_type || ''
  });
  const sharedShortTermContext = buildShortTermContextMessages(state.userId, state.userInfo, {
    chatHistory,
    shortTermMemory,
    routeMeta,
    sessionKey: state.sessionKey
  });
  const memoryContext = await buildMemoryContextAsync(state.userId, state.question || '', {
    routePolicyKey: state.routePolicyKey,
    topRouteType: state.topRouteType,
    groupId: routeMeta.groupId || routeMeta.group_id || '',
    sessionId: routeMeta.sessionId || routeMeta.session_id || '',
    taskType: routeMeta.taskType || routeMeta.task_type || '',
    agentName: routeMeta.agentName || routeMeta.agent_name || '',
    toolName: routeMeta.toolName || routeMeta.tool_name || '',
    sharedShortTermSignature: sharedShortTermContext.sharedShortTermSignature
  });

  if (state.customPrompt) {
    return { dynamicPrompt: state.customPrompt, memoryContext, affinity };
  }

  const promptParts = [
    config.SYSTEM_PROMPT,
    `[Affinity] ${state.userInfo.level}`,
    `[AffinityPoints] ${affinity.points}`,
    `[DailyMemory] ${memoryContext.memoryForPrompt}`,
    `[LongTermProfile] ${memoryContext.longTermProfileText || memoryContext.profileText}`,
    `[Impression] ${trimTextByTokenBudget(memoryContext.impressionText || 'none', Math.max(96, Math.floor(affinity.shortTermMemoryTokens * 0.2)), 'tail') || 'none'}`,
    `[Summary] ${trimTextByTokenBudget(memoryContext.summary || 'none', affinity.shortTermMemoryTokens, 'tail') || 'none'}`,
    ...buildRelationshipPromptLines(memoryContext)
  ];
  if (shouldExposeMemoryCliForGraphState(state)) {
    const memoryCliInstruction = buildMemoryCliInstruction(state.memoryCliTurn);
    if (memoryCliInstruction) promptParts.push(memoryCliInstruction);
  }
  let dynamicPrompt = promptParts.join('\n');
  const dynamicFewShotPrompt = buildDynamicFewShotPrompt({
    question: state.question,
    routePolicyKey: state.routePolicyKey,
    topRouteType: state.topRouteType,
    routePrompt: state.routePrompt,
    maxExamples: 3
  });
  if (dynamicFewShotPrompt) {
    dynamicPrompt = [dynamicPrompt, dynamicFewShotPrompt].filter(Boolean).join('\n\n');
  }
  const promptBudget = Math.max(1200, affinity.contextWindowTokens - affinity.shortTermMemoryTokens);
  if (estimateTokens(dynamicPrompt) > promptBudget) {
    dynamicPrompt = [
      config.SYSTEM_PROMPT,
      `[Affinity] ${state.userInfo.level}`,
      `[AffinityPoints] ${affinity.points}`,
      `[DailyMemory] ${trimTextByTokenBudget(memoryContext.memoryForPrompt, Math.floor(promptBudget * 0.35), 'tail')}`,
      `[LongTermProfile] ${trimTextByTokenBudget(memoryContext.longTermProfileText || memoryContext.profileText, Math.floor(promptBudget * 0.28), 'tail') || '暂无'}`,
      `[Impression] ${trimTextByTokenBudget(memoryContext.impressionText || 'none', Math.floor(promptBudget * 0.15), 'tail') || 'none'}`,
      `[Summary] ${trimTextByTokenBudget(memoryContext.summary || 'none', Math.floor(promptBudget * 0.25), 'tail') || 'none'}`,
      ...buildRelationshipPromptLines(memoryContext)
    ].join('\n');
  }

  return { dynamicPrompt, memoryContext, affinity };
}

async function ensureDynamicPromptCache(state) {
  const normalizedState = normalizeGraphState(state);
  const expectedPromptKey = getMemoryCliTurnPromptKey(normalizedState.memoryCliTurn);
  if (
    normalizedState.dynamicPromptCache
    && typeof normalizedState.dynamicPromptCache === 'object'
    && String(normalizedState.dynamicPromptCache.memoryCliPromptKey || '') === expectedPromptKey
  ) {
    return {
      state: normalizedState,
      dynamicPromptCache: normalizedState.dynamicPromptCache
    };
  }

  const dynamicPromptCache = await buildDynamicPrompt(normalizedState);
  return {
    state: {
      ...normalizedState,
      dynamicPromptCache: {
        ...dynamicPromptCache,
        memoryCliPromptKey: expectedPromptKey
      }
    },
    dynamicPromptCache: {
      ...dynamicPromptCache,
      memoryCliPromptKey: expectedPromptKey
    }
  };
}

async function buildHumanizerContext(state) {
  const { dynamicPromptCache } = await ensureDynamicPromptCache(state);
  return {
    dynamicPrompt: dynamicPromptCache.dynamicPrompt,
    routePrompt: String(state.routePrompt || '').trim()
  };
}

function isReviewMode(reviewMode = '') {
  return Boolean(String(reviewMode || '').trim());
}

function normalizeGraphState(state) {
  const input = state && typeof state === 'object' ? state : {};
  const routePolicyKey = String(input.routePolicyKey || '').trim();
  const reviewMode = String(input.reviewMode || '').trim();
  const isReviewRoute = isReviewMode(reviewMode);
  const dynamicPromptCache = input.dynamicPromptCache && typeof input.dynamicPromptCache === 'object'
    ? input.dynamicPromptCache
    : null;
  return {
    ...input,
    question: String(input.question || ''),
    userId: String(input.userId || ''),
    sessionKey: String(input.sessionKey || resolveShortTermSessionKey(input.userId, input.routeMeta) || '').trim(),
    routePrompt: String(input.routePrompt || '').trim(),
    routePolicyKey,
    topRouteType: String(input.topRouteType || input.routeMeta?.topRouteType || '').trim(),
    reviewMode,
    routeMeta: input.routeMeta && typeof input.routeMeta === 'object' ? input.routeMeta : null,
    imageUrl: input.imageUrl || null,
    streaming: isReviewRoute ? false : Boolean(input.streaming),
    allowTools: isReviewRoute ? false : Boolean(input.allowTools),
    allowedTools: isReviewRoute ? [] : normalizeToolNames(input.allowedTools),
    planRuntime: normalizePlanRuntime(input.planRuntime, routePolicyKey),
    toolLoopCount: Number.isFinite(Number(input.toolLoopCount)) ? Math.max(0, Math.floor(Number(input.toolLoopCount))) : 0,
    memoryCliTurn: normalizeMemoryCliTurnState(input.memoryCliTurn),
    dynamicPromptCache,
    messages: Array.isArray(input.messages) ? input.messages : [],
    finalReply: String(input.finalReply || ''),
    userInfo: input.userInfo || { level: 'stranger' }
  };
}

function getAllowedToolNamesSet(state = {}) {
  if (!Array.isArray(state?.allowedTools)) return null;
  return new Set(state.allowedTools);
}

function shouldExposeMemoryCliForGraphState(state = {}) {
  if (!config.MEMORY_CLI_ENABLED || !config.MEMORY_CLI_CHAT_ENABLED) return false;
  if (state?.allowTools === false) return false;
  if (String(state?.customPrompt || '').trim()) return false;
  if (isReviewMode(state?.reviewMode)) return false;

  const routeMeta = state?.routeMeta && typeof state.routeMeta === 'object' ? state.routeMeta : {};
  const routePolicyKey = String(state?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(state?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  const blockedRoutePrefixes = ['review', 'admin', 'refuse', 'ignore', 'proactive'];
  if (new Set(blockedRoutePrefixes).has(topRouteType)) return false;
  if (blockedRoutePrefixes.some((prefix) => routePolicyKey.startsWith(`${prefix}/`))) return false;
  return topRouteType === 'chat' || routePolicyKey === 'chat/default' || (!topRouteType && !routePolicyKey);
}

function mergeAllowedToolsWithMemoryCliForGraph(state = {}) {
  const base = Array.isArray(state?.allowedTools) ? normalizeToolNames(state.allowedTools) : [];
  const withMemoryCli = (!shouldExposeMemoryCliForGraphState(state) || base.includes('memory_cli'))
    ? base
    : [...base, 'memory_cli'];
  return filterAllowedToolsForMemoryCliTurn(withMemoryCli, state?.memoryCliTurn);
}

function buildMemoryCliInstruction(memoryCliTurn = null) {
  if (!config.MEMORY_CLI_ENABLED || !config.MEMORY_CLI_CHAT_ENABLED) return '';
  const lines = [
    '[MemoryCLI]',
    'Use tool memory_cli only when the injected memory context is insufficient and you need to verify long-term memory details.',
    'The `command` field must contain only a bare command string. Do not add natural language, JSON, code fences, or a `command:` prefix.',
    'Prefer `mem search --query "..."` first, then `mem open --ref "..."` for exact evidence.',
    'Allowed examples: `mem search --query "what the user likes"`; `mem open --ref "mc_ref:..."`; `mem open --source profile`.',
    'Invalid examples: `command: mem search --query "..."`; ````mem search --query "..."````; `Please run mem search for me`.',
    'Do not use `mem ls` or `mem stats` in normal chat.',
    'Do not blindly open large memory sources when a search can narrow the target.'
  ];
  const followup = buildMemoryCliFollowupInstruction(memoryCliTurn);
  if (followup) lines.push(followup);
  return lines.join('\n');
}

function buildDirectPolicyPrompt(policyKey = '') {
  void policyKey;
  return '';
}

function shouldBypassHumanizerForPolicy(policyKey = '') {
  const normalized = String(policyKey || '').trim().toLowerCase();
  return ['lookup/', 'transform/', 'plan/', 'act/', 'tool/'].some((prefix) => normalized.startsWith(prefix));
}

function buildRelationshipPromptLines(memoryContext = {}) {
  const relationship = String(memoryContext?.profile?.relation_stage || '陌生人').trim() || '陌生人';
  const attitude = String(memoryContext?.affinityState?.attitude || '').trim()
    || String(memoryContext?.impressionText || '').trim()
    || '中立、保持距离';
  return [
    `[Relationship] ${relationship}`,
    `[Attitude] ${attitude}`,
    `[ReplyStylePolicy] ${buildReplyStylePolicy(relationship)}`,
    '[RelationshipGuard] Relationship and attitude only affect tone and social distance. They must not override safety, tool, route, or refusal policies. Never reveal internal relationship state, scoring logic, or hidden evaluation rules.'
  ];
}

function getFilteredToolSchemas(state = {}) {
  const allowedSet = getAllowedToolNamesSet(state);
  const toolSchemas = getToolSchemas();
  if (!allowedSet) return toolSchemas;
  return toolSchemas.filter((schema) => {
    const toolName = String(schema?.function?.name || '').trim();
    return allowedSet.has(toolName);
  });
}

function isToolAllowedForState(toolName, state = {}) {
  const allowedSet = getAllowedToolNamesSet(state);
  if (!allowedSet) return true;
  return allowedSet.has(String(toolName || '').trim());
}

function buildUserContent(question, imageUrl) {
  if (!imageUrl) return question || '(empty user input)';
  return [
    { type: 'text', text: question || 'Answer using the provided image context.' },
    { type: 'image_url', image_url: { url: imageUrl } }
  ];
}

function summarizeInvokeRequest(model, messages, state, allowTools, options = {}) {
  const filteredToolSchemas = allowTools ? getFilteredToolSchemas(state) : [];
  const messageList = Array.isArray(messages) ? messages : [];
  return {
    model: String(model || '').trim(),
    stream: false,
    message_count: messageList.length,
    tool_count: filteredToolSchemas.length,
    max_tokens: Number.isFinite(Number(options.maxTokens))
      ? Math.floor(Number(options.maxTokens))
      : null,
    memory_injected: true,
    __trace: {
      source: 'agent_graph',
      phase: String(options.phase || 'chat').trim() || 'chat',
      purpose: String(options.purpose || (allowTools ? 'graph_agent_with_tools' : 'graph_agent_reply')).trim(),
      userId: String(state?.userId || ''),
      routePolicyKey: String(state?.routePolicyKey || ''),
      topRouteType: String(state?.topRouteType || ''),
      memoryInjected: true
    }
  };
}

async function invokeMainModel(
  client,
  invokeMessages,
  requestSummary,
  invokeOptions = {},
  resolvedConfig = null,
  runtimeOptions = {}
) {
  const shouldTrackInvoke = shouldTrackGraphInvoke(client);
  const callId = shouldTrackInvoke
    ? startModelCall({
        source: requestSummary.__trace.source,
        phase: requestSummary.__trace.phase,
        purpose: requestSummary.__trace.purpose,
        userId: requestSummary.__trace.userId,
        routePolicyKey: requestSummary.__trace.routePolicyKey,
        topRouteType: requestSummary.__trace.topRouteType,
        model: requestSummary.model,
        request: requestSummary,
        memoryInjected: requestSummary.__trace.memoryInjected
      })
    : '';

  try {
    const resp = await client.invoke(invokeMessages, invokeOptions);
    if (callId) {
      finishModelCall(callId, {
        attempts: 1,
        response: { model: resp?.response_metadata?.model_name || requestSummary.model }
      });
    }
    recordMainModelSuccess({ usingFallback: Boolean(resolvedConfig?.__mainFallbackActive) });
    return resp;
  } catch (error) {
    if (callId) failModelCall(callId, error, { attempts: 1 });
    if (shouldBypassMainModelFallback(requestSummary?.__trace?.userId || '', {
      routeMeta: requestSummary?.__trace?.routeMeta
    })) throw error;
    const failureState = recordMainModelFailure(error);
    if (failureState.activated && !resolvedConfig?.__mainFallbackActive) {
      const forcedFallbackConfig = resolveForcedFallbackMainModelConfig(
        resolveRoleAwareMainModelConfig(requestSummary?.__trace?.userId || '', {
          model: resolvedConfig?.model,
          apiBaseUrl: resolvedConfig?.apiBaseUrl,
          apiKey: resolvedConfig?.apiKey
        }, {
          routeMeta: requestSummary?.__trace?.routeMeta
        })
      );
      const fallbackClient = createGraphModelClient({
        apiBaseUrl: forcedFallbackConfig.apiBaseUrl,
        apiKey: forcedFallbackConfig.apiKey,
        model: forcedFallbackConfig.model,
        temperature: runtimeOptions.temperature,
        topP: runtimeOptions.topP,
        timeoutMs: runtimeOptions.requestTimeoutMs,
        retries: runtimeOptions.retries
      });
      return invokeMainModel(
        fallbackClient,
        invokeMessages,
        {
          ...requestSummary,
          model: forcedFallbackConfig.model
        },
        invokeOptions,
        forcedFallbackConfig,
        runtimeOptions
      );
    }
    throw error;
  }
}

function buildInvokeMessages({
  dynamicPrompt,
  routePrompt,
  summaryMessage,
  trimmedHistory,
  userContent,
  stateMessages,
  includeHumanizerSystemPrompt = true
}) {
  return [
    { role: 'system', content: dynamicPrompt },
    ...(includeHumanizerSystemPrompt ? [{ role: 'system', content: HUMANIZER_SYSTEM_PROMPT }] : []),
    ...(routePrompt ? [{ role: 'system', content: routePrompt }] : []),
    ...(summaryMessage ? [summaryMessage] : []),
    ...trimmedHistory,
    { role: 'user', content: userContent },
    ...stateMessages
  ];
}

function appendChatHistory(userId, userContent, assistantContent, userInfo = {}, options = {}) {
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const sessionKey = String(options?.sessionKey || resolveShortTermSessionKey(userId, routeMeta) || '').trim();
  appendShortTermHistory(userId, userContent, assistantContent, userInfo, {
    chatHistory,
    shortTermMemory,
    routeMeta,
    sessionKey
  });

  if (options.persistBridge) {
    persistShortTermBridgeSnapshot(userId, {
      chatHistory,
      shortTermMemory,
      routeMeta,
      sessionKey,
      scope: resolveShortTermScope(userId, routeMeta, sessionKey),
      snapshotType: 'post_reply'
    });
  }
}

function shouldAppendDailyJournal(question, finalReply, userId, customPrompt = null, options = {}) {
  if (!config.DAILY_JOURNAL_ENABLED) return false;
  if (options?.disableDailyJournal) return false;

  // customPrompt usually means system/review/proactive flow, not real user free chat.
  if (String(customPrompt || '').trim()) return false;

  const uid = String(userId || '').trim();
  const q = String(question || '').trim();
  const a = String(finalReply || '').trim();
  if (!uid || !q || !a) return false;
  if (looksLikeFailureReply(a)) return false;

  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || options?.routeMeta?.topRouteType || '').trim().toLowerCase();
  if (!topRouteType && !routePolicyKey) return true;
  if (topRouteType) return topRouteType === 'chat';
  return routePolicyKey === 'chat/default';
}

function appendDailyJournalIfNeeded(question, finalReply, userInfo, userId, customPrompt = null, options = {}) {
  if (!shouldAppendDailyJournal(question, finalReply, userId, customPrompt, options)) return;
  appendDailyJournalEntry(userId, question, finalReply, userInfo);
}

function shouldUseGraphStreaming(imageUrl = null, options = {}) {
  if (!config.AI_STREAM_ENABLED) return false;
  if (config.HUMANIZER_FORCE_NON_STREAM) return false;
  if (imageUrl) return false;
  return typeof options.onDelta === 'function' && !options.disableStream;
}

function isToolMetadata(metadata) {
  const name = String(metadata?.name || metadata?.langgraph_node || '').toLowerCase();
  return name === 'tools' || name.includes('tool');
}

function normalizeChunkText(message) {
  if (!message) return '';
  return safeReadMessageText(message);
}

function shouldSuppressStreamMessage(message, text = '') {
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    // Tool-call turn is an intermediate planning step, not user-facing final text.
    return true;
  }

  if (looksLikeFailureReply(text)) {
    // Do not leak upstream block/auth/risk-control text into streamed user output.
    return true;
  }

  return false;
}

function extractStreamDelta(previousText, currentText) {
  const prev = String(previousText || '');
  const next = String(currentText || '');
  if (!next) return '';
  if (!prev) return next;
  if (next === prev) return '';
  if (next.startsWith(prev)) return next.slice(prev.length);
  if (prev.endsWith(next) || prev.includes(next)) return '';

  const maxOverlap = Math.min(prev.length, next.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (prev.slice(-size) === next.slice(0, size)) {
      return next.slice(size);
    }
  }

  return next;
}

function looksLikeFailureReply(text = '') {
  return isReplyFailure(text, { emptyIsFailure: true });
}

function shouldQueueMemoryLearning(question, finalReply, userId, customPrompt = null, options = {}) {
  if (!config.MEMORY_LEARNING_ENABLED) return false;
  if (options?.disableMemoryLearning) return false;

  // customPrompt usually means system/review/proactive flow, not real user free chat.
  if (String(customPrompt || '').trim()) return false;

  const uid = String(userId || '').trim();
  const q = String(question || '').trim();
  const a = String(finalReply || '').trim();
  if (!uid || !q || !a) return false;
  if (looksLikeFailureReply(a)) return false;

  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || options?.routeMeta?.topRouteType || '').trim().toLowerCase();
  const reviewMode = String(options?.reviewMode || '').trim().toLowerCase();
  if (!topRouteType && !routePolicyKey) return true;
  if (reviewMode) return false;
  if (new Set(['admin', 'ignore', 'refuse']).has(topRouteType || '')) return false;

  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const hasGroupId = Boolean(String(routeMeta.groupId || routeMeta.group_id || '').trim());
  const hasTaskContext = Boolean(
    String(routeMeta.taskType || routeMeta.task_type || '').trim()
    || String(routeMeta.toolName || routeMeta.tool_name || '').trim()
    || String(routeMeta.agentName || routeMeta.agent_name || '').trim()
  );

  if (topRouteType === 'chat') return true;
  if (hasGroupId) return true;
  if (hasTaskContext) return true;
  if (new Set(['lookup', 'transform', 'plan', 'act']).has(topRouteType)) return true;
  if (!topRouteType && routePolicyKey === 'chat/default') return true;
  return ['plan/', 'lookup/', 'transform/', 'act/'].some((prefix) => routePolicyKey.startsWith(prefix));
}

function queueMemoryLearning(question, finalReply, userId, customPrompt = null, options = {}) {
  if (!shouldQueueMemoryLearning(question, finalReply, userId, customPrompt, options)) return;

  // Run extraction in background so normal reply latency is not affected.
  setTimeout(() => {
    if (config.ENABLE_DEBUG_LOG) {
      console.log('[memory] queued async long-term extraction', {
        userId: String(userId || ''),
        routePolicyKey: String(options?.routePolicyKey || ''),
        topRouteType: String(options?.topRouteType || options?.routeMeta?.topRouteType || '')
      });
    }

    Promise.resolve()
      .then(() => {
        return learnSomethingNew(userId, question, finalReply, {
          routePolicyKey: String(options?.routePolicyKey || ''),
          topRouteType: String(options?.topRouteType || options?.routeMeta?.topRouteType || ''),
          groupId: String(options?.routeMeta?.groupId || options?.routeMeta?.group_id || ''),
          sessionId: String(options?.routeMeta?.sessionId || options?.routeMeta?.session_id || ''),
          taskType: String(options?.routeMeta?.taskType || options?.routeMeta?.task_type || ''),
          agentName: String(options?.routeMeta?.agentName || options?.routeMeta?.agent_name || ''),
          toolName: String(options?.routeMeta?.toolName || options?.routeMeta?.tool_name || ''),
          channelId: String(options?.routeMeta?.channelId || options?.routeMeta?.channel_id || '')
        });
      })
      .catch((e) => {
        console.error('[memory] async extraction failed:', e?.message || e);
      });
  }, 0);
}

function shouldRestoreShortTermAfterRestart(question, userId, customPrompt = null, options = {}) {
  if (String(customPrompt || '').trim()) return false;

  const uid = String(userId || '').trim();
  const q = String(question || '').trim();
  if (!uid || !q) return false;

  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  if (topRouteType && topRouteType !== 'chat') return false;
  if (routePolicyKey && !routePolicyKey.startsWith('chat/')) return false;
  if (String(options?.reviewMode || '').trim()) return false;

  return true;
}

function shouldRehydrateShortTermMemory(question, userId, customPrompt = null, options = {}) {
  if (!config.RESTART_RECALL_ENABLED) return false;
  return shouldRestoreShortTermAfterRestart(question, userId, customPrompt, options);
}

function shouldPersistShortTermBridge(question, finalReply, userId, customPrompt = null, options = {}) {
  if (!config.SHORT_TERM_BRIDGE_ENABLED) return false;
  if (!shouldRestoreShortTermAfterRestart(question, userId, customPrompt, options)) return false;

  const reply = String(finalReply || '').trim();
  if (!reply) return false;
  if (looksLikeFailureReply(reply)) return false;
  if (reply === 'I did not catch that clearly. Please try again.') return false;

  return true;
}

async function emitGraphMessageChunk(chunk, trackers, options = {}) {
  if (!Array.isArray(chunk) || chunk.length === 0) return false;

  const message = chunk[0];
  const metadata = chunk[1] || {};
  if (!message || isToolMetadata(metadata)) return false;

  // Prefer per-message identity; run_id can span multiple nodes and pollute delta tracking.
  const messageKey = String(message.id || metadata.langgraph_checkpoint_ns || metadata.run_id || 'anonymous');
  const text = normalizeChunkText(message);
  if (!text) return false;
  if (shouldSuppressStreamMessage(message, text)) return false;

  const previousText = trackers.messageTexts.get(messageKey) || '';
  let delta = extractStreamDelta(previousText, text);
  if (!previousText) {
    delta = extractStreamDelta(trackers.fullText, text);
  }
  if (!delta) {
    trackers.messageTexts.set(messageKey, text);
    return false;
  }

  trackers.messageTexts.set(messageKey, text);
  trackers.fullText += delta;
  options.streamHadOutput = true;
  await options.onDelta(delta, trackers.fullText);
  return true;
}

function buildApp() {
  const temperature = Number.isFinite(Number(config.AI_TEMPERATURE))
    ? Math.max(0, Math.min(2, Number(config.AI_TEMPERATURE)))
    : 0.6;
  // Keep sampling controls aligned with api/ai.js so graph/non-graph behavior is consistent.
  const topP = Number.isFinite(Number(config.AI_TOP_P))
    ? Math.max(0, Math.min(1, Number(config.AI_TOP_P)))
    : 0.92;
  const retries = Number.isFinite(Number(config.AI_RETRIES))
    ? Math.max(0, Math.floor(Number(config.AI_RETRIES)))
    : 1;
  const requestTimeoutMs = Math.max(
    Number(config.REQUEST_TIMEOUT_MS) || 30000,
    Number(config.REQUEST_STREAM_TIMEOUT_MS) || 120000
  );

  // Dedicated LLM instance for tool-enabled calls. Falls back to the main llm when
  // TOOLS_API_BASE_URL / TOOLS_API_KEY / TOOLS_MODEL are not configured.
  const hasToolsEndpoint = Boolean(String(config.TOOLS_API_BASE_URL || '').trim());
  const toolsLlm = hasToolsEndpoint
    ? createGraphModelClient({
        apiBaseUrl: config.TOOLS_API_BASE_URL,
        apiKey: getToolsApiKey(),
        model: getToolsModelName(),
        temperature,
        topP,
        timeoutMs: requestTimeoutMs,
        retries
      })
    : null;

  async function routerNode(state) {
    return normalizeGraphState(state);
  }

function buildToolLoopLimitMessage(toolLoopCount) {
  return `记忆那边刚刚绕住了，连续转了 ${toolLoopCount} 轮。`;
}

async function invokeAgentTurn(state, options = {}) {
  const normalizedState = normalizeGraphState(state);
  const { state: cachedState, dynamicPromptCache } = await ensureDynamicPromptCache(normalizedState);
  const affinity = dynamicPromptCache.affinity;
  const dynamicPrompt = dynamicPromptCache.dynamicPrompt;
  const recentContext = getRecentChatHistory(cachedState.userId, cachedState.userInfo, {
    routeMeta: cachedState.routeMeta,
    sessionKey: cachedState.sessionKey
  });
  const userContent = buildUserContent(cachedState.question, cachedState.imageUrl);
  const mainModelConfig = getCurrentMainModelConfig(cachedState.userId, {
    routeMeta: cachedState.routeMeta
  });
  const mainLlm = createGraphModelClient({
    apiBaseUrl: mainModelConfig.apiBaseUrl,
    apiKey: mainModelConfig.apiKey,
    model: mainModelConfig.model,
    temperature,
    topP,
    timeoutMs: requestTimeoutMs,
    retries
  });
  const activeToolsLlm = hasToolsEndpoint ? toolsLlm : mainLlm;
  const effectiveAllowedTools = mergeAllowedToolsWithMemoryCliForGraph(cachedState);
  const stateWithEffectiveTools = {
    ...cachedState,
    allowedTools: effectiveAllowedTools
  };
  const allowTools = Boolean(options.allowTools) && getFilteredToolSchemas(stateWithEffectiveTools).length > 0;
  const includeHumanizerSystemPrompt = options.includeHumanizerSystemPrompt !== false;

  const baseMessages = [
    { role: 'system', content: dynamicPrompt },
    ...(includeHumanizerSystemPrompt ? [{ role: 'system', content: HUMANIZER_SYSTEM_PROMPT }] : []),
    ...(cachedState.routePrompt ? [{ role: 'system', content: cachedState.routePrompt }] : []),
    ...(recentContext.summaryMessage ? [recentContext.summaryMessage] : []),
    { role: 'user', content: userContent }
  ];
  const fixedCost = estimateMessagesTokens(baseMessages);
  const historyBudget = Math.max(256, affinity.contextWindowTokens - fixedCost);
  const trimmedHistory = trimMessagesByTokenBudget(recentContext.history, historyBudget);

  try {
    const invokeMessages = buildInvokeMessages({
      dynamicPrompt,
      routePrompt: cachedState.routePrompt,
      summaryMessage: recentContext.summaryMessage,
      trimmedHistory,
      userContent,
      stateMessages: cachedState.messages,
      includeHumanizerSystemPrompt
    });
    const normalizedInvokeMessages = shouldMergeSystemMessagesForProvider(
      mainModelConfig.apiBaseUrl,
      mainModelConfig.model
    )
      ? mergeSystemMessages(invokeMessages)
      : invokeMessages;

    const requestSummary = summarizeInvokeRequest(
      mainModelConfig.model,
      normalizedInvokeMessages,
      stateWithEffectiveTools,
      allowTools,
      {
        phase: String(options.logTag || 'chat').trim() || 'chat',
        purpose: String(options.requestPurpose || (allowTools ? 'graph_agent_with_tools' : 'graph_agent_reply')).trim()
      }
    );

    let resp;
    if (allowTools) {
      try {
        if (hasToolsEndpoint) {
          const shouldTrackToolsInvoke = shouldTrackGraphInvoke(activeToolsLlm);
          const callId = shouldTrackToolsInvoke
            ? startModelCall({
        source: requestSummary.__trace.source,
        phase: requestSummary.__trace.phase,
        purpose: requestSummary.__trace.purpose,
        userId: requestSummary.__trace.userId,
        routePolicyKey: requestSummary.__trace.routePolicyKey,
        topRouteType: requestSummary.__trace.topRouteType,
        model: requestSummary.model,
        request: requestSummary,
        memoryInjected: requestSummary.__trace.memoryInjected
              })
            : '';
          try {
            resp = await activeToolsLlm.invoke(normalizedInvokeMessages, {
              tools: getFilteredToolSchemas(stateWithEffectiveTools),
              tool_choice: 'auto'
            });
            if (callId) {
              finishModelCall(callId, {
                attempts: 1,
                response: { model: resp?.response_metadata?.model_name || requestSummary.model }
              });
            }
          } catch (toolError) {
            if (callId) failModelCall(callId, toolError, { attempts: 1 });
            throw toolError;
          }
        } else {
          resp = await invokeMainModel(
            activeToolsLlm,
            normalizedInvokeMessages,
            requestSummary,
            {
              tools: getFilteredToolSchemas(cachedState),
              tool_choice: 'auto'
            },
            mainModelConfig,
            { temperature, topP, requestTimeoutMs, retries }
          );
        }
      } catch (toolError) {
        if (!isToolSchemaValidationError(toolError)) throw toolError;
        const fallbackSummary = summarizeInvokeRequest(
          mainModelConfig.model,
          normalizedInvokeMessages,
          stateWithEffectiveTools,
          false,
          {
            phase: String(options.logTag || 'chat').trim() || 'chat',
            purpose: String(options.fallbackPurpose || 'graph_agent_reply').trim() || 'graph_agent_reply'
          }
        );
        resp = await invokeMainModel(
          mainLlm,
          normalizedInvokeMessages,
          fallbackSummary,
          {},
          mainModelConfig,
          { temperature, topP, requestTimeoutMs, retries }
        );
      }
    } else {
      resp = await invokeMainModel(
        mainLlm,
        normalizedInvokeMessages,
        requestSummary,
        {},
        mainModelConfig,
        { temperature, topP, requestTimeoutMs, retries }
      );
    }

    const reachedToolLoopLimit = allowTools
      && Array.isArray(resp?.tool_calls)
      && resp.tool_calls.length > 0
      && cachedState.toolLoopCount >= Math.max(1, Number(config.AGENT_MAX_ROUNDS) || 8);

    const nextMessage = reachedToolLoopLimit
      ? {
          role: 'assistant',
          content: buildToolLoopLimitMessage(cachedState.toolLoopCount)
        }
      : resp;

    return {
        ...cachedState,
        allowedTools: effectiveAllowedTools,
        messages: [...cachedState.messages, nextMessage]
      };
  } catch (e) {
    const detail = e?.response?.data
      ? JSON.stringify(e.response.data).slice(0, 800)
      : (e.stack || e.message || String(e));

    if (config.LANGGRAPH_DEBUG) {
      console.error(`[${String(options.errorLogTag || 'agentNode').trim()}.invoke.error]`, detail);
    }

    return {
      ...cachedState,
      allowedTools: effectiveAllowedTools,
      messages: [
        ...cachedState.messages,
        {
          role: 'assistant',
          content: `模型调用刚刚卡住了：${String(e.message || 'unknown error')}`
        }
      ]
    };
  }
}

async function agentNode(state) {
  return invokeAgentTurn(state, {
    allowTools: state.allowTools,
    includeHumanizerSystemPrompt: true,
    logTag: 'chat',
    requestPurpose: state.allowTools ? 'graph_agent_with_tools' : 'graph_agent_reply',
    fallbackPurpose: 'graph_agent_reply',
    errorLogTag: 'agentNode'
  });
}

async function reviewAgentNode(state) {
  return invokeAgentTurn(state, {
    allowTools: false,
    includeHumanizerSystemPrompt: false,
    logTag: 'review',
    requestPurpose: 'graph_review_reply',
    fallbackPurpose: 'graph_review_reply',
    errorLogTag: 'reviewAgentNode'
  });
}

async function executeSingleToolCall(call, state) {
  const toolName = call.name;
  const args = call.args || {};
  let toolResult = 'Tool execution failed';
  let nextMemoryCliTurn = normalizeMemoryCliTurnState(state.memoryCliTurn);
  let invalidateDynamicPromptCache = false;

    try {
      if (!isToolAllowedForState(toolName, state)) {
        toolResult = `Tool not allowed: ${toolName}`;
        return {
          role: 'tool',
          tool_call_id: call.id || `${Date.now()}_${Math.random()}`,
          content: toolResult,
          __toolRuntime: {
            toolName: String(toolName || '').trim(),
            status: 'blocked'
          }
        };
      }
      const executor = getToolExecutors()[toolName];
      if (!executor) {
        toolResult = `Unknown tool: ${toolName}`;
      } else {
        const normalizedArgs = enforceToolPolicy(toolName, args, { userId: state.userId });
        if (toolName === 'memory_cli') {
          const decision = decideMemoryCliTurnAction(normalizedArgs.command, state.memoryCliTurn);
          if (!decision.ok) {
            nextMemoryCliTurn = decision.nextState;
            invalidateDynamicPromptCache = true;
            console.log('[memory] memory_cli turn blocked', {
              commandName: String(decision.parsed?.commandName || 'memory_cli').trim(),
              reason: decision.reason,
              repairApplied: Boolean(decision.repairApplied),
              invalidReason: String(decision.invalidReason || ''),
              rawPreview: String((decision.result?.rawCommandText || normalizedArgs.command || '')).replace(/\s+/g, ' ').trim().slice(0, 180),
              normalizedPreview: String((decision.result?.normalizedCommandText || decision.preparedCommand || '')).replace(/\s+/g, ' ').trim().slice(0, 180)
            });
            console.log('[memory] memory_cli turn state updated', {
              commandName: String(decision.parsed?.commandName || 'memory_cli').trim(),
              ok: false,
              searchCount: nextMemoryCliTurn.searchCount,
              openCount: nextMemoryCliTurn.openCount,
              mustAnswer: nextMemoryCliTurn.mustAnswer,
              reason: decision.reason,
              repairApplied: Boolean(decision.repairApplied),
              invalidReason: String(decision.invalidReason || '')
            });
            toolResult = JSON.stringify(decision.result);
            return {
              role: 'tool',
              tool_call_id: call.id || `${Date.now()}_${Math.random()}`,
              content: toolResult,
              __toolRuntime: {
                toolName: String(toolName || '').trim(),
                status: 'blocked',
                memoryCliTurn: nextMemoryCliTurn,
                invalidateDynamicPromptCache
              }
            };
          }
          if (decision.repairApplied) {
            console.log('[memory] memory_cli command normalized', {
              rawPreview: String((normalizedArgs.command || '')).replace(/\s+/g, ' ').trim().slice(0, 180),
              normalizedPreview: String((decision.preparedCommand || decision.parsed?.raw || '')).replace(/\s+/g, ' ').trim().slice(0, 180),
              repairStrategy: Array.isArray(decision.repairStrategy) ? decision.repairStrategy : []
            });
          }
          normalizedArgs.command = decision.preparedCommand || decision.parsed?.raw || normalizedArgs.command;
          normalizedArgs.__context = {
            userId: String(state.userId || '').trim(),
            routePolicyKey: String(state.routePolicyKey || '').trim(),
            topRouteType: String(state.topRouteType || '').trim(),
            routeMeta: state.routeMeta && typeof state.routeMeta === 'object' ? state.routeMeta : {}
          };
          const out = await executor(normalizedArgs);
          toolResult = typeof out === 'string' ? out : JSON.stringify(out);
          nextMemoryCliTurn = updateMemoryCliTurnStateAfterResult(state.memoryCliTurn, decision.parsed, toolResult);
          invalidateDynamicPromptCache = true;
          console.log('[memory] memory_cli turn state updated', {
            commandName: String(decision.parsed?.commandName || '').trim(),
            ok: true,
            searchCount: nextMemoryCliTurn.searchCount,
            openCount: nextMemoryCliTurn.openCount,
            mustAnswer: nextMemoryCliTurn.mustAnswer,
            reason: nextMemoryCliTurn.mustAnswer ? 'must_answer' : 'ok',
            repairApplied: Boolean(decision.repairApplied),
            invalidReason: ''
          });
          return {
            role: 'tool',
            tool_call_id: call.id || `${Date.now()}_${Math.random()}`,
            content: toolResult,
            __toolRuntime: {
              toolName: String(toolName || '').trim(),
              status: getToolResultStatus(toolResult),
              memoryCliTurn: nextMemoryCliTurn,
              invalidateDynamicPromptCache
            }
          };
        }
        const out = await executor(normalizedArgs);
        toolResult = typeof out === 'string' ? out : JSON.stringify(out);
      }
    } catch (e) {
      toolResult = `Tool error: ${e.message}`;
      if (toolName === 'memory_cli') {
        nextMemoryCliTurn = updateMemoryCliTurnStateAfterError(state.memoryCliTurn, 'tool_error');
        invalidateDynamicPromptCache = true;
        console.log('[memory] memory_cli turn state updated', {
          commandName: 'memory_cli',
          ok: false,
          searchCount: nextMemoryCliTurn.searchCount,
          openCount: nextMemoryCliTurn.openCount,
          mustAnswer: nextMemoryCliTurn.mustAnswer,
          reason: 'tool_error'
        });
      }
    }

  return {
    role: 'tool',
    tool_call_id: call.id || `${Date.now()}_${Math.random()}`,
    content: toolResult,
    __toolRuntime: {
      toolName: String(toolName || '').trim(),
      status: getToolResultStatus(toolResult),
      ...(toolName === 'memory_cli'
        ? {
            memoryCliTurn: nextMemoryCliTurn,
            invalidateDynamicPromptCache
          }
        : {})
    }
  };
}

  function canRunToolsInParallel(toolCalls = []) {
    if (!config.AGENT_PARALLEL_SAFE_TOOLS) return false;
    if (!Array.isArray(toolCalls) || toolCalls.length < 2) return false;

    // Parallel mode is limited to low-risk tools to avoid side-effect ordering issues.
    return toolCalls.every((call) => {
      const toolName = String(call?.name || '').trim();
      if (!toolName) return false;
      return String(getPolicy(toolName)?.risk || 'low') === 'low';
    });
  }

  async function toolsNode(state) {
    const last = state.messages[state.messages.length - 1];
    const toolCalls = last?.tool_calls || [];

    let toolMessages = [];
    if (canRunToolsInParallel(toolCalls)) {
      toolMessages = await Promise.all(toolCalls.map((call) => executeSingleToolCall(call, state)));
    } else {
      for (const call of toolCalls) {
        toolMessages.push(await executeSingleToolCall(call, state));
      }
    }

    let nextPlanRuntime = state.planRuntime;
    let nextMemoryCliTurn = normalizeMemoryCliTurnState(state.memoryCliTurn);
    let shouldInvalidateDynamicPromptCache = false;
    for (const message of toolMessages) {
      const toolName = String(message?.__toolRuntime?.toolName || '').trim();
      const runtimeStatus = String(message?.__toolRuntime?.status || '').trim();
      nextPlanRuntime = recordPlanRuntimeToolResult(nextPlanRuntime, toolName, message?.content || '', runtimeStatus);
      if (toolName === 'memory_cli' && message?.__toolRuntime?.memoryCliTurn) {
        nextMemoryCliTurn = normalizeMemoryCliTurnState(message.__toolRuntime.memoryCliTurn);
      }
      if (Boolean(message?.__toolRuntime?.invalidateDynamicPromptCache)) {
        shouldInvalidateDynamicPromptCache = true;
      }
    }
    if (nextPlanRuntime) {
      console.log('[agentGraph.planRuntime.tools]', summarizePlanRuntime(nextPlanRuntime));
    }

    return {
      ...state,
      toolLoopCount: Number(state.toolLoopCount || 0) + 1,
      planRuntime: nextPlanRuntime,
      memoryCliTurn: nextMemoryCliTurn,
      dynamicPromptCache: shouldInvalidateDynamicPromptCache ? null : state.dynamicPromptCache,
      messages: [...state.messages, ...toolMessages]
    };
  }

  async function finalNode(state) {
    const last = state.messages[state.messages.length - 1];
    let text = safeReadMessageText(last);
    if (!text) {
      text = 'I did not catch that clearly. Please try again.';
    }
    const isFailureReply = looksLikeFailureReply(text);

    // 非流式输出在最终节点进入 Humanizer 子 Agent，保留原文风格做最小改写。
    // Source-test anchor: if (!state.streaming && !isFailureReply) {
    if (!state.streaming && !isFailureReply && !shouldBypassHumanizerForPolicy(state.routePolicyKey)) {
      const humanizerContext = await buildHumanizerContext(state);
      text = await runHumanizerAgent(text, {
        question: state.question,
        dynamicPrompt: [
          humanizerContext.dynamicPrompt,
          humanizerContext.routePrompt ? `[RoutePrompt]\n${humanizerContext.routePrompt}` : ''
        ].filter(Boolean).join('\n\n')
      });
    }

    const userContent = state.imageUrl ? (state.question || '[shared an image]') : (state.question || '');
    // Source-test anchor: if (!isFailureReply && userContent) appendChatHistory(state.userId, userContent, text, state.userInfo);
    if (!isFailureReply && userContent) {
      appendChatHistory(state.userId, userContent, text, state.userInfo, {
        persistBridge: shouldPersistShortTermBridge(state.question, text, state.userId, state.customPrompt, {
          routePolicyKey: state.routePolicyKey,
          topRouteType: state.topRouteType,
          reviewMode: state.reviewMode,
          routeMeta: state.routeMeta
        }),
        routeMeta: state.routeMeta,
        sessionKey: state.sessionKey
      });
    }

    if (!isFailureReply && state.question) {
      addProfileItem(state.userId, 'recent_topics', state.question.slice(0, 20), 12);
    }

    const finalizedPlanRuntime = finalizePlanRuntime(state.planRuntime, text);
    if (finalizedPlanRuntime) {
      console.log('[agentGraph.planRuntime.final]', summarizePlanRuntime(finalizedPlanRuntime));
    }

    return {
      ...state,
      planRuntime: finalizedPlanRuntime,
      finalReply: text
    };
  }

  function routeAfterRouter(state) {
    if (isReviewMode(state?.reviewMode)) return 'review';
    return 'agent';
  }

  function routeAfterAgent(state) {
    const last = state.messages[state.messages.length - 1];
    if (last?.tool_calls && last.tool_calls.length > 0) return 'tools';
    return 'final';
  }

  const graph = new StateGraph({
    channels: {
      question: null,
      userInfo: null,
      userId: null,
      sessionKey: null,
      customPrompt: null,
      routePrompt: null,
      routePolicyKey: null,
      topRouteType: null,
      reviewMode: null,
      routeMeta: null,
      imageUrl: null,
      streaming: null,
      allowTools: null,
      allowedTools: null,
      planRuntime: null,
      toolLoopCount: null,
      memoryCliTurn: null,
      dynamicPromptCache: null,
      messages: null,
      finalReply: null
    }
  });


  graph.addNode('router', routerNode);
  graph.addNode('agent', agentNode);
  graph.addNode('review', reviewAgentNode);
  graph.addNode('tools', toolsNode);
  graph.addNode('final', finalNode);

  graph.setEntryPoint('router');
  graph.addConditionalEdges('router', routeAfterRouter, {
    review: 'review',
    agent: 'agent'
  });
  graph.addEdge('review', 'final');
  graph.addConditionalEdges('agent', routeAfterAgent, {
    tools: 'tools',
    final: 'final'
  });
  graph.addEdge('tools', 'agent');
  graph.addEdge('final', END);

  return graph.compile();
}

let app = null;
function getApp() {
  if (!app) app = buildApp();
  return app;
}

async function askAIByGraphV1(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  // Graph app caches one ChatOpenAI client, so image turns need the ai.js path
  // to honor IMAGE_MODEL / IMAGE_API_BASE_URL per request.
  if (imageUrl) {
    const { askAI } = require('../ai');
    const reply = await askAI(question, userInfo, userId, customPrompt, imageUrl, options);
    queueMemoryLearning(question, reply, userId, customPrompt, options);
    return reply;
  }

  // Graph app caches a single model/baseURL. Route minecraft requests to ai.js so
  // those turns can use MC_* dedicated endpoint/model settings.
  if (shouldUseMinecraftLLM(question, options.routePrompt)) {
    const { askAI } = require('../ai');
    const reply = await askAI(question, userInfo, userId, customPrompt, imageUrl, {
      ...options,
      modelConfig: getMinecraftModelOverrides()
    });
    queueMemoryLearning(question, reply, userId, customPrompt, options);
    return reply;
  }

  const compiled = getApp();
  const useStreaming = shouldUseGraphStreaming(imageUrl, options);
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  if (shouldExposeMemoryCliForGraphState({
    question,
    userId,
    customPrompt,
    routePolicyKey: options.routePolicyKey,
    topRouteType: options.topRouteType,
    reviewMode: options.reviewMode,
    routeMeta,
    allowTools: !options.disableTools,
    allowedTools: options.allowedTools
  })) {
    recordMemoryScope(userId, routeMeta);
  }
  const sessionKey = resolveShortTermSessionKey(userId, routeMeta);
  const sessionScope = resolveShortTermScope(userId, routeMeta, sessionKey);
  if (shouldRestoreShortTermAfterRestart(question, userId, customPrompt, options)) {
    const bridgeRestore = restoreShortTermBridgeAfterRestartIfNeeded(userId, {
      chatHistory,
      shortTermMemory,
      routeMeta,
      sessionKey
    });
    if (!bridgeRestore.restored && shouldRehydrateShortTermMemory(question, userId, customPrompt, options)) {
      rehydrateShortTermMemoryAfterRestartIfNeeded(userId, question, userInfo, {
        chatHistory,
        shortTermMemory,
        routeMeta,
        sessionKey
      });
    }
  }
  await compressShortTermHistoryIfNeeded(userId, userInfo, {
    chatHistory,
    shortTermMemory,
    routeMeta,
    sessionKey,
    summarizeChunk: async ({ existingSummary, existingState, chunkText, summaryTokens }) => {
      // Use a small dedicated summarization prompt so graph chat keeps one shared short-term state.
      const resp = await postWithRetry(
        getMemoryChatCompletionsUrl(),
        {
          model: getMemoryModelName(),
          temperature: 0.2,
          top_p: 0.9,
          messages: [
            {
              role: 'system',
              content: [
                buildStructuredCompressionPrompt(existingState || { summary: existingSummary }, summaryTokens),
                '如果无法稳定输出 JSON，退回输出纯文本短期摘要。'
              ].join('\n')
            },
            { role: 'user', content: chunkText }
          ],
          max_tokens: Math.max(96, Math.min(400, summaryTokens)),
          stream: false
        },
        Math.max(0, Number(config.AI_RETRIES) || 0),
        getMemoryApiKey()
      );

      const msg = extractMessageContent(resp);
      return safeReadMessageText(msg).trim();
    }
  });
  if (config.SHORT_TERM_PENDING_SNAPSHOT_ENABLED && shouldRestoreShortTermAfterRestart(question, userId, customPrompt, options)) {
    persistShortTermBridgeSnapshot(userId, {
      chatHistory,
      shortTermMemory,
      routeMeta,
      sessionKey,
      scope: sessionScope,
      snapshotType: 'pre_reply',
      shortTermState: {
        carryOverUserTurn: imageUrl ? (question || '[shared an image]') : (question || '')
      }
    });
  }
  const init = createInitialState({
    question,
    userInfo,
    userId,
    sessionKey,
    customPrompt,
    routePrompt: options.routePrompt,
    routePolicyKey: options.routePolicyKey,
    topRouteType: options.topRouteType,
    reviewMode: options.reviewMode,
    routeMeta: options.routeMeta,
    imageUrl,
    streaming: useStreaming,
    allowTools: !options.disableTools,
    allowedTools: mergeAllowedToolsWithMemoryCliForGraph({
      question,
      userId,
      customPrompt,
      routePolicyKey: options.routePolicyKey,
      topRouteType: options.topRouteType,
      reviewMode: options.reviewMode,
      routeMeta: options.routeMeta,
      allowTools: !options.disableTools,
      allowedTools: options.allowedTools
    })
  });

  if (!useStreaming) {
    const out = await compiled.invoke(init);
    const finalReply = out?.finalReply || 'The network was unstable just now. Please try again.';
    appendDailyJournalIfNeeded(question, finalReply, userInfo, userId, customPrompt, options);
    queueMemoryLearning(question, finalReply, userId, customPrompt, options);
    return finalReply;
  }

  if (isHumanizerAgentEnabled() && !shouldBypassHumanizerForPolicy(options.routePolicyKey)) {
    // 有去 AI 味子 Agent 时，对外只流式发送润色后的最终文本。
    const out = await compiled.invoke(init);
    const baseReply = String(out?.finalReply || 'The network was unstable just now. Please try again.');
    if (looksLikeFailureReply(baseReply)) {
      const failure = classifyReplyFailure(baseReply);
      console.log('[memory] reply failure classified', {
        type: failure.type,
        routePolicyKey: String(options?.routePolicyKey || '').trim(),
        topRouteType: String(options?.topRouteType || options?.routeMeta?.topRouteType || '').trim()
      });
      options.streamCompleted = true;
      appendDailyJournalIfNeeded(question, baseReply, userInfo, userId, customPrompt, options);
      queueMemoryLearning(question, baseReply, userId, customPrompt, options);
      return baseReply;
    }
    const humanizerContext = await buildHumanizerContext(out || init);
    const finalReply = await runHumanizerAgent(baseReply, {
      question,
      dynamicPrompt: [
        humanizerContext.dynamicPrompt,
        humanizerContext.routePrompt ? `[RoutePrompt]\n${humanizerContext.routePrompt}` : ''
      ].filter(Boolean).join('\n\n'),
      stream: true,
      onDelta: options.onDelta,
      streamHadOutput: options.streamHadOutput,
      maxSegments: Number(config.AI_STREAM_MAX_SEGMENTS) || 3
    });
    options.streamCompleted = true;
    appendDailyJournalIfNeeded(question, finalReply, userInfo, userId, customPrompt, options);
    queueMemoryLearning(question, finalReply, userId, customPrompt, options);
    return finalReply;
  }

  const trackers = {
    fullText: '',
    messageTexts: new Map()
  };
  let finalState = null;

  const stream = await compiled.stream(init, {
    streamMode: ['messages', 'values']
  });

  for await (const [event, chunk] of stream) {
    if (event === 'messages') {
      await emitGraphMessageChunk(chunk, trackers, options);
      continue;
    }

    if (event === 'values') {
      finalState = chunk;
    }
  }

  options.streamCompleted = true;
  const finalReply = String(finalState?.finalReply || trackers.fullText || 'The network was unstable just now. Please try again.');
  appendDailyJournalIfNeeded(question, finalReply, userInfo, userId, customPrompt, options);
  queueMemoryLearning(question, finalReply, userId, customPrompt, options);
  return finalReply;
}

async function askAIByGraph(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  // Keep V1 as a rollback path. Operators can switch runtimes via env without
  // changing callers or touching route selection code above.
  if (Number(config.LANGGRAPH_RUNTIME_VERSION) >= 2) {
    return askAIByGraphV2(question, userInfo, userId, customPrompt, imageUrl, options);
  }
  return askAIByGraphV1(question, userInfo, userId, customPrompt, imageUrl, options);
}

module.exports = {
  askAIByGraph,
  askAIByGraphV1,
  createPlanRuntime,
  extractStreamDelta,
  finalizePlanRuntime,
  looksLikeFailureReply,
  recordPlanRuntimeToolResult,
  shouldSuppressStreamMessage
};

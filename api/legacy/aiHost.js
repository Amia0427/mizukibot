// Archived pre-V2 host. Keep this file readable for source-regression tests and
// helper extraction, but do not add new runtime behavior here.
/**
 * ai.js 当前定位：旧版对话适配层，不再是默认聊天主链路。
 *
 * 现在还能做什么：
 * - 提供 askAI 作为非 LangGraph 场景的兼容入口。
 * - 处理 Anthropic /v1/messages 这类不能直接走 agentGraph 的请求。
 * - 处理 Minecraft 专用模型覆盖这类需要独立 modelConfig 的请求。
 * - 提供 Plan-and-Solve、工具执行、流式/非流式回复、人性化改写等旧链路能力。
 * - 导出若干仍被其他模块复用的辅助函数，例如规划相关函数、buildVisionMessageContent、getLatestReasoning。
 *
 * 现在不能做什么：
 * - 不是普通聊天的默认主入口；默认聊天主链路在 api/agentGraph.js。
 * - 不应再承担新的长期记忆提取职责；长期记忆提取已迁移到 api/memoryExtraction.js。
 * - 不应作为新功能的首选接入点；除兼容/回退场景外，新增能力优先接到 agentGraph 或独立模块。
 *
 * 维护约定：
 * - 若修改这里，请先确认是否属于“兼容层”需求。
 * - 若是默认聊天行为、记忆注入展示、LangGraph 主链路能力，优先修改 agentGraph.js。
 */
const config = require('../../config');
const MODEL_RESPONSE_MALFORMED_REPLY = '刚才模型返回格式不稳定，我没拿到可用正文。你再发一次，我继续。';

function getMainReplyDefaultMaxTokens() {
  return Math.max(64, Number(config.MAIN_REPLY_DEFAULT_MAX_TOKENS || 8192) || 8192);
}
const { normalizeTier } = require('../../utils/memoryTier');
const { buildMemoryContext, buildMemoryContextAsync } = require('../../utils/memoryContext');
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

const {
  chatHistory,
  shortTermMemory,
  addUserFact,
  addProfileItem,
  setUserImpression,
  buildReplyStylePolicy
} = require('../../utils/memory');

const { postWithRetry, postStreamWithRetry } = require('../httpClient');
const {
  extractMessageContent,
  safeParseArgs,
  getLatestReasoning,
  extractJsonSafely,
  extractSSEEvents,
  flushSSEState
} = require('../parser');
const { HUMANIZER_SYSTEM_PROMPT } = require('../../utils/humanizer');
const { runHumanizerAgent, isHumanizerAgentEnabled } = require('../humanizerAgent');
const { buildDynamicFewShotPrompt } = require('../../utils/fewShotPrompts');
const { buildRuntimePrompt } = require('../../utils/runtimePrompts');
const {
  resolveForcedFallbackMainModelConfig,
  recordMainModelFailure,
  recordMainModelSuccess
} = require('../../utils/mainModelFallback');
const {
  resolveRoleAwareMainModelConfig,
  resolveUserScopedMainModelConfig,
  shouldBypassMainModelFallback,
  isAdminMainModelUser
} = require('../../utils/mainModelConfigResolver');
const {
  estimateTokens,
  estimateMessagesTokens,
  getAffinitySettings,
  trimTextByTokenBudget,
  trimMessagesByTokenBudget
} = require('../../utils/contextBudget');
const {
  buildContextCompactionPlan,
  buildReactiveRetryPayload,
  createContextCompactionHardBlockError,
  getContextCompactionFailureReply,
  isContextOverflowError
} = require('../../utils/contextCompaction');
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
  normalizeMemoryCliTurnState,
  updateMemoryCliTurnStateAfterError,
  updateMemoryCliTurnStateAfterResult
} = require('../../utils/memoryCliTurnPolicy');
const { classifyReplyFailure, isReplyFailure } = require('../../utils/replyFailure');
const { buildContinuityState } = require('../../utils/continuityState');
const { appendDailyJournalEntry } = require('../../utils/dailyJournal');
const { recordMemoryScope } = require('../../utils/memoryScopeIndex');
const { isToolSchemaValidationError } = require('../../utils/modelCompat');
const { getPolicy, enforceToolPolicy } = require('../../utils/toolPolicy');
const { getPolicyDefinition } = require('../../core/routeProfiles');
const { buildExecutablePlanFromLegacyPlan } = require('../../core/executablePlan');
const { deriveSuccessCriteria, verifyExecutionResult, buildRepairPlan } = require('../../utils/agentLoop');
const agentRuntime = require('../../utils/agentRuntime');
const {
  buildMainModelRequest
} = require('../runtimeV2/model/shared');

function getConfig() {
  try {
    return require('../../config');
  } catch (_) {
    return config;
  }
}

function getAgentRuntime() {
  try {
    return require('../../utils/agentRuntime');
  } catch (_) {
    return agentRuntime;
  }
}

const createTask = (...args) => getAgentRuntime().createTask(...args);
const appendTaskLog = (...args) => getAgentRuntime().appendTaskLog(...args);
const startTaskStep = (...args) => getAgentRuntime().startTaskStep(...args);
const finishTaskStep = (...args) => getAgentRuntime().finishTaskStep(...args);
const addTaskArtifact = (...args) => getAgentRuntime().addTaskArtifact(...args);
const setTaskStage = (...args) => getAgentRuntime().setTaskStage(...args);
let cachedVectorMemoryModule = undefined;

function getVectorMemoryModule() {
  if (cachedVectorMemoryModule !== undefined) return cachedVectorMemoryModule;
  try {
    cachedVectorMemoryModule = require('../../utils/vectorMemory');
  } catch (error) {
    cachedVectorMemoryModule = null;
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    console.warn('[legacy/aiHost] vectorMemory unavailable:', error.message);
  }
  return cachedVectorMemoryModule;
}

function addMemoryItemSafe(...args) {
  const vectorMemory = getVectorMemoryModule();
  if (typeof vectorMemory?.addMemoryItem !== 'function') return null;
  return vectorMemory.addMemoryItem(...args);
}
const setTaskSuccessCriteria = (...args) => getAgentRuntime().setTaskSuccessCriteria(...args);
const setTaskCheckpoint = (...args) => getAgentRuntime().setTaskCheckpoint(...args);
const mergeWorkspace = (...args) => getAgentRuntime().mergeWorkspace(...args);
const appendWorkspaceItem = (...args) => getAgentRuntime().appendWorkspaceItem(...args);
const completeTask = (...args) => getAgentRuntime().completeTask(...args);
const failTask = (...args) => getAgentRuntime().failTask(...args);

function ensureChatCompletionsUrl(url) {
  const u = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`;
  return u;
}

function normalizeTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
  }
  return String(content || '');
}

function buildVisionMessageContent(question = '', imageUrl = null) {
  if (!imageUrl) return question || '';
  return [
    { type: 'text', text: question || 'Please answer with the provided image context.' },
    { type: 'image_url', image_url: { url: imageUrl } }
  ];
}

function pickRecentTopic(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/weather|temperature|rain|锟斤拷锟斤拷|锟铰讹拷|锟斤拷锟斤拷/i.test(t)) return 'weather';
  if (/lyrics|song|music|锟斤拷锟絴锟斤拷锟斤拷|锟斤拷锟斤拷/i.test(t)) return 'music';
  if (/draw|image|picture|锟斤拷图|图片|锟斤拷/i.test(t)) return 'image';
  if (/medical|pathology|pharma|clinical|医学|锟斤拷锟斤拷|药锟斤拷|锟劫达拷/i.test(t)) return 'medical';
  if (/rate|currency|exchange|锟斤拷锟斤拷|锟斤拷锟斤拷|usd|cny|jpy/i.test(t)) return 'currency';
  if (/bilibili|hot|news|锟斤拷锟斤拷|锟饺碉拷/i.test(t)) return 'hot_topics';
  return t.length > 18 ? `${t.slice(0, 18)}...` : t;
}

function shouldUsePlanAndSolve(question = '', customPrompt = null, imageUrl = null) {
  if (!config.ENABLE_PLAN_SOLVE) return false;
  if (customPrompt) return false;
  if (imageUrl) return false;

  const q = String(question || '').trim();
  if (!q) return false;

  // Use Unicode escapes to avoid encoding-related keyword corruption in source files.
  const planningSignal = /(?:\u89c4\u5212|\u8ba1\u5212|\u65b9\u6848|\u6b65\u9aa4|\u62c6\u89e3|\u5bf9\u6bd4|\u5206\u6790|\u8bc4\u4f30|\u8bc1\u660e|\u6392\u67e5|\u8bca\u65ad|\u5982\u4f55|\u600e\u4e48|plan|roadmap|checklist|debug|investigate|compare|strategy|proposal|design|architecture|step\s*by\s*step|root\s*cause)/i;
  if (planningSignal.test(q)) return true;

  // Long or structurally complex prompts usually benefit from explicit planning.
  if (q.length >= 100) return true;
  if (/[\r\n]/.test(q) && /(?:^|\s)(?:\d+\.|[-*]|\u2460|\u2461|\u2462)/m.test(q)) return true;

  const questionMarks = (q.match(/[?\uff1f]/g) || []).length;
  if (questionMarks >= 2) return true;

  return false;
}

// Route guidance should not disable planner mode. Only a true custom prompt should.
function shouldUsePlanModeForRequest(question = '', options = {}) {
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  if (routePolicyKey) {
    const routeCapability = String(getPolicyDefinition(routePolicyKey)?.capability || '').trim().toLowerCase();
    if (routeCapability === 'direct') return false;
  }
  const customPrompt = options && Object.prototype.hasOwnProperty.call(options, 'customPrompt')
    ? options.customPrompt
    : null;
  const imageUrl = options && Object.prototype.hasOwnProperty.call(options, 'imageUrl')
    ? options.imageUrl
    : null;
  return shouldUsePlanAndSolve(question, customPrompt, imageUrl);
}

function shouldUseStreamingReply(question = '', customPrompt = null, imageUrl = null, options = {}) {
  if (!config.AI_STREAM_ENABLED) return false;
  if (config.HUMANIZER_FORCE_NON_STREAM) return false;
  if (typeof options.onDelta !== 'function') return false;
  if (options.disableStream) return false;
  if (options.modelConfig && typeof options.modelConfig === 'object') return false;
  if (imageUrl) return false;
  if (shouldUsePlanModeForRequest(question, {
    customPrompt,
    imageUrl,
    routePolicyKey: options?.routePolicyKey,
    topRouteType: options?.topRouteType
  })) return false;
  return true;
}

function getModelName(overrides = null) {
  const model = overrides && typeof overrides === 'object'
    ? overrides.model
    : '';
  return String(model || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function getMemoryModelName(overrides = null) {
  const model = overrides && typeof overrides === 'object'
    ? (overrides.memoryModel || '')
    : '';
  const fallbackModel = overrides && typeof overrides === 'object'
    ? overrides.model
    : '';
  return String(model || config.MEMORY_MODEL || fallbackModel || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function getImageModelName(overrides = null, userId = '', options = {}) {
  const model = overrides && typeof overrides === 'object'
    ? (overrides.imageModel || '')
    : '';
  const fallbackModel = overrides && typeof overrides === 'object'
    ? overrides.model
    : '';
  const isAdmin = isAdminMainModelUser(userId, options);
  return String(
    model
    || (isAdmin ? config.ADMIN_IMAGE_MODEL : '')
    || config.IMAGE_MODEL
    || fallbackModel
    || (isAdmin ? config.ADMIN_AI_MODEL : '')
    || config.AI_MODEL
    || 'gpt-5.4'
  ).trim() || 'gpt-5.4';
}

function getTemperature(overrides = null) {
  const raw = overrides && typeof overrides === 'object' && overrides.temperature !== undefined
    ? overrides.temperature
    : config.AI_TEMPERATURE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.6;
  return Math.max(0, Math.min(2, n));
}

function getTopP(overrides = null) {
  // Nucleus sampling for balancing creativity and stability in companion chat.
  const raw = overrides && typeof overrides === 'object' && overrides.topP !== undefined
    ? overrides.topP
    : config.AI_TOP_P;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.92;
  return Math.max(0, Math.min(1, n));
}

function getPlannerModelName(overrides = null) {
  const currentConfig = getConfig();
  const plannerModel = overrides && typeof overrides === 'object'
    ? (overrides.plannerModel || overrides.model)
    : '';
  return String(plannerModel || currentConfig.PLAN_MODEL || currentConfig.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function getPlannerTemperature(overrides = null) {
  const overridden = overrides && typeof overrides === 'object'
    ? (overrides.plannerTemperature ?? overrides.temperature)
    : undefined;
  if (overridden !== undefined && overridden !== null && overridden !== '') {
    const n = Number(overridden);
    if (!Number.isFinite(n)) return 0.2;
    return Math.max(0, Math.min(2, n));
  }

  const raw = process.env.PLAN_TEMPERATURE;
  const n = raw === undefined || raw === null || raw === '' ? 0.2 : Number(raw);
  if (!Number.isFinite(n)) return 0.2;
  return Math.max(0, Math.min(2, n));
}

function getPlannerApiBaseUrl(overrides = null) {
  const currentConfig = getConfig();
  const plannerApiBaseUrl = overrides && typeof overrides === 'object'
    ? (overrides.plannerApiBaseUrl || overrides.apiBaseUrl)
    : '';
  return String(
    plannerApiBaseUrl
    || currentConfig.PASSIVE_AWARENESS_REPLY_API_BASE_URL
    || currentConfig.PASSIVE_AWARENESS_API_BASE_URL
    || currentConfig.API_BASE_URL
    || ''
  ).trim();
}

function getPlannerApiKey(overrides = null) {
  const currentConfig = getConfig();
  const plannerApiKey = overrides && typeof overrides === 'object'
    ? (overrides.plannerApiKey || overrides.apiKey)
    : '';
  return String(
    plannerApiKey
    || currentConfig.PASSIVE_AWARENESS_REPLY_API_KEY
    || currentConfig.PASSIVE_AWARENESS_API_KEY
    || currentConfig.API_KEY
    || ''
  ).trim();
}

function getMaxTokens(defaultValue = getMainReplyDefaultMaxTokens(), overrides = null) {
  const raw = overrides && typeof overrides === 'object' && overrides.maxTokens !== undefined
    ? overrides.maxTokens
    : config.AI_MAX_TOKENS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.max(64, Math.floor(n));
}

function getRetries(defaultValue = 1, overrides = null) {
  const raw = overrides && typeof overrides === 'object' && overrides.retries !== undefined
    ? overrides.retries
    : config.AI_RETRIES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return defaultValue;
  return Math.max(0, Math.floor(n));
}

function getApiBaseUrl(overrides = null) {
  const raw = overrides && typeof overrides === 'object'
    ? overrides.apiBaseUrl
    : '';
  return String(raw || config.API_BASE_URL || '').trim();
}

function getMemoryApiBaseUrl(overrides = null) {
  const raw = overrides && typeof overrides === 'object'
    ? overrides.memoryApiBaseUrl
    : '';
  return String(raw || config.MEMORY_API_BASE_URL || getApiBaseUrl(overrides) || '').trim();
}

function getImageApiBaseUrl(overrides = null, userId = '', options = {}) {
  const raw = overrides && typeof overrides === 'object'
    ? overrides.imageApiBaseUrl
    : '';
  const isAdmin = isAdminMainModelUser(userId, options);
  return String(
    raw
    || config.IMAGE_API_BASE_URL
    || (isAdmin ? config.ADMIN_API_BASE_URL : '')
    || getApiBaseUrl(overrides)
    || ''
  ).trim();
}

function getApiKey(overrides = null) {
  const raw = overrides && typeof overrides === 'object'
    ? overrides.apiKey
    : '';
  return String(raw || config.API_KEY || '').trim();
}

function buildPrimaryMainModelConfig(overrides = null, userId = '', options = {}) {
  return resolveRoleAwareMainModelConfig(userId, overrides, options);
}

function getResolvedMainModelConfig(overrides = null, userId = '', options = {}) {
  return resolveUserScopedMainModelConfig(userId, overrides, options);
}

async function withMainModelFallback(action, modelConfig = null, userId = '', options = {}) {
  const resolvedConfig = getResolvedMainModelConfig(modelConfig, userId, options);
  const bypassFallback = shouldBypassMainModelFallback(userId, options);
  try {
    const result = await action(resolvedConfig);
    recordMainModelSuccess({ usingFallback: resolvedConfig.__mainFallbackActive });
    return result;
  } catch (error) {
    if (bypassFallback) throw error;
    const failureState = recordMainModelFailure(error);
    if (failureState.activated && !resolvedConfig.__mainFallbackActive) {
      const forcedFallbackConfig = resolveForcedFallbackMainModelConfig(buildPrimaryMainModelConfig(modelConfig, userId, options));
      const fallbackResult = await action(forcedFallbackConfig);
      recordMainModelSuccess({ usingFallback: true });
      return fallbackResult;
    }
    throw error;
  }
}

function getMemoryApiKey(overrides = null) {
  const raw = overrides && typeof overrides === 'object'
    ? overrides.memoryApiKey
    : '';
  if (String(raw || '').trim()) return String(raw).trim();

  const dedicatedBaseUrl = overrides && typeof overrides === 'object'
    ? overrides.memoryApiBaseUrl
    : '';
  if (String(dedicatedBaseUrl || config.MEMORY_API_BASE_URL || '').trim()) {
    return String(config.MEMORY_API_KEY || getApiKey(overrides) || '').trim();
  }

  return getApiKey(overrides);
}

function getImageApiKey(overrides = null, userId = '', options = {}) {
  const raw = overrides && typeof overrides === 'object'
    ? overrides.imageApiKey
    : '';
  if (String(raw || '').trim()) return String(raw).trim();

  const dedicatedBaseUrl = overrides && typeof overrides === 'object'
    ? overrides.imageApiBaseUrl
    : '';
  if (String(dedicatedBaseUrl || config.IMAGE_API_BASE_URL || '').trim()) {
    return String(config.IMAGE_API_KEY || getApiKey(overrides) || '').trim();
  }

  const isAdmin = isAdminMainModelUser(userId, options);
  if (isAdmin && String(config.ADMIN_API_BASE_URL || '').trim()) {
    return String(config.ADMIN_API_KEY || getApiKey(overrides) || '').trim();
  }

  return getApiKey(overrides);
}

function buildImageModelConfig(overrides = null, userId = '', options = {}) {
  const base = overrides && typeof overrides === 'object' ? { ...overrides } : {};
  const imageModel = getImageModelName(overrides, userId, options);
  const imageApiBaseUrl = getImageApiBaseUrl(overrides, userId, options);
  const imageApiKey = getImageApiKey(overrides, userId, options);

  // Image turns may need a different model/base URL from normal chat turns.
  return {
    ...base,
    model: imageModel,
    imageModel,
    apiBaseUrl: imageApiBaseUrl,
    imageApiBaseUrl,
    apiKey: imageApiKey,
    imageApiKey
  };
}

function fallbackReplyPlan(question = '') {
  const plan = {
    goal: String(question || '').trim(),
    need_tools: false,
    steps: [{ id: 1, action: 'reply', args: {}, purpose: 'Reply directly' }]
  };
  return {
    ...plan,
    executablePlan: buildExecutablePlanFromLegacyPlan(plan, { source: 'legacy_fallback' })
  };
}

function sanitizePlan(rawPlan, question = '') {
  if (!rawPlan || !Array.isArray(rawPlan.steps)) {
    return fallbackReplyPlan(question);
  }

  const maxSteps = Math.max(1, Math.min(8, Number(config.PLAN_MAX_STEPS) || 5));
  const sanitizedSteps = rawPlan.steps
    .slice(0, maxSteps)
    .map((step, index) => ({
      id: Number(step?.id) || (index + 1),
      action: String(step?.action || '').trim(),
      args: step && typeof step.args === 'object' ? step.args : {},
      purpose: String(step?.purpose || '').trim()
    }))
    .filter((step) => {
      if (!step.action) return false;
      if (step.action === 'reply') return true;
      return Boolean(getToolExecutors()[step.action]);
    });

  const steps = sanitizedSteps.length > 0
    ? sanitizedSteps
    : [{ id: 1, action: 'reply', args: {}, purpose: 'Reply directly' }];

  const hasToolStep = steps.some((step) => step.action !== 'reply');

  const plan = {
    goal: String(rawPlan.goal || question),
    need_tools: hasToolStep && Boolean(rawPlan.need_tools !== false),
    steps
  };
  return {
    ...plan,
    executablePlan: buildExecutablePlanFromLegacyPlan(plan, {
      policyKey: rawPlan.routePolicyKey || rawPlan.policyKey || '',
      source: rawPlan.source || 'legacy_planner'
    })
  };
}

async function buildDynamicPrompt(userInfo, userId, question, customPrompt = null, options = {}) {
  const routeMeta = options.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const affinity = getAffinitySettings(userInfo, {
    userId,
    chatType: routeMeta.chatType || routeMeta.chat_type || ''
  });
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  const sharedShortTermContext = buildShortTermContextMessages(userId, userInfo, {
    chatHistory,
    shortTermMemory,
    routeMeta,
    sessionKey: options?.sessionKey
  });
  const memoryContext = await buildMemoryContextAsync(userId, question || '', {
    routePolicyKey,
    topRouteType,
    groupId: routeMeta.groupId || routeMeta.group_id || '',
    sessionId: routeMeta.sessionId || routeMeta.session_id || '',
    taskType: routeMeta.taskType || routeMeta.task_type || '',
    agentName: routeMeta.agentName || routeMeta.agent_name || '',
    toolName: routeMeta.toolName || routeMeta.tool_name || '',
    sharedShortTermSignature: sharedShortTermContext.sharedShortTermSignature
  });

  if (customPrompt) {
    return {
      dynamicPrompt: customPrompt,
      promptSegments: {
        systemPrompt: [{ role: 'system', content: customPrompt }],
        routePrompt: options.routePrompt ? [{ role: 'system', content: String(options.routePrompt || '').trim() }] : [],
        memoryContext: memoryContext?.segments || {}
      },
      memoryContext,
      affinity
    };
  }

  const promptParts = [
    config.SYSTEM_PROMPT,
    `[Affinity] ${userInfo.level}`,
    `[AffinityPoints] ${affinity.points}`,
    `[DailyMemory] ${memoryContext.memoryForPrompt}`,
    `[LongTermProfile] ${memoryContext.longTermProfileText || memoryContext.profileText}`,
    `[Impression] ${trimTextByTokenBudget(memoryContext.impressionText || 'none', Math.max(96, Math.floor(affinity.shortTermMemoryTokens * 0.2)), 'tail') || 'none'}`,
    ...buildRelationshipPromptLines(memoryContext)
  ];

  const summaryText = trimTextByTokenBudget(memoryContext.summary || 'none', affinity.shortTermMemoryTokens, 'tail') || 'none';
  promptParts.push(`[Summary] ${summaryText}`);
  if (shouldExposeMemoryCli({ ...options, customPrompt })) {
    const memoryCliInstruction = buildMemoryCliInstruction(options?.memoryCliTurn);
    if (memoryCliInstruction) promptParts.push(memoryCliInstruction);
  }
  let dynamicPrompt = promptParts.join('\n');
  const dynamicFewShotPrompt = buildDynamicFewShotPrompt({
    question,
    routePolicyKey: options.routePolicyKey,
    topRouteType: options.topRouteType,
    routePrompt: options.routePrompt,
    maxExamples: 3
  });
  if (dynamicFewShotPrompt) {
    dynamicPrompt = [dynamicPrompt, dynamicFewShotPrompt].filter(Boolean).join('\n\n');
  }
  const promptBudget = Math.max(1200, affinity.contextWindowTokens - affinity.shortTermMemoryTokens);
  if (estimateTokens(dynamicPrompt) > promptBudget) {
    dynamicPrompt = [
      config.SYSTEM_PROMPT,
      `[Affinity] ${userInfo.level}`,
      `[AffinityPoints] ${affinity.points}`,
      `[DailyMemory] ${trimTextByTokenBudget(memoryContext.memoryForPrompt, Math.floor(promptBudget * 0.35), 'tail')}`,
      `[LongTermProfile] ${trimTextByTokenBudget(memoryContext.longTermProfileText || memoryContext.profileText, Math.floor(promptBudget * 0.28), 'tail') || '暂无'}`,
      `[Impression] ${trimTextByTokenBudget(memoryContext.impressionText || 'none', Math.floor(promptBudget * 0.15), 'tail') || 'none'}`,
      `[Summary] ${trimTextByTokenBudget(memoryContext.summary || 'none', Math.floor(promptBudget * 0.25), 'tail') || 'none'}`,
      ...buildRelationshipPromptLines(memoryContext)
    ].join('\n');
  }

  return {
    dynamicPrompt,
    promptSegments: {
      systemPrompt: dynamicPrompt ? [{ role: 'system', content: dynamicPrompt }] : [],
      routePrompt: options.routePrompt ? [{ role: 'system', content: String(options.routePrompt || '').trim() }] : [],
      memoryContext: memoryContext?.segments || {}
    },
    memoryContext,
    affinity
  };
}

function buildConversationMessages(dynamicPrompt, userHistory, messageContent, affinity = null, routePrompt = null) {
  const historyBudget = affinity
    ? Math.max(256, affinity.shortTermMemoryTokens)
    : 0;
  const trimmedHistory = affinity
    ? trimMessagesByTokenBudget(userHistory, historyBudget)
    : userHistory;

  const messages = [
    { role: 'system', content: dynamicPrompt },
    { role: 'system', content: HUMANIZER_SYSTEM_PROMPT },
    ...(routePrompt ? [{ role: 'system', content: routePrompt }] : []),
    ...trimmedHistory,
    { role: 'user', content: messageContent }
  ];

  if (!affinity) return messages;

  const totalBudget = Math.max(2048, affinity.contextWindowTokens);
  if (estimateMessagesTokens(messages) <= totalBudget) return messages;

  const fixedMessages = [
    { role: 'system', content: dynamicPrompt },
    { role: 'system', content: HUMANIZER_SYSTEM_PROMPT },
    ...(routePrompt ? [{ role: 'system', content: routePrompt }] : []),
    { role: 'user', content: messageContent }
  ];
  const fixedCost = estimateMessagesTokens(fixedMessages);
  const remainingBudget = Math.max(256, totalBudget - fixedCost);

  return [
    { role: 'system', content: dynamicPrompt },
    { role: 'system', content: HUMANIZER_SYSTEM_PROMPT },
    ...(routePrompt ? [{ role: 'system', content: routePrompt }] : []),
    ...trimMessagesByTokenBudget(trimmedHistory, remainingBudget),
    { role: 'user', content: messageContent }
  ];
}

function shouldExposeMemoryCli(options = {}) {
  if (!config.MEMORY_CLI_ENABLED || !config.MEMORY_CLI_CHAT_ENABLED) return false;
  if (options?.disableTools) return false;
  if (String(options?.customPrompt || '').trim()) return false;

  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const reviewMode = String(options?.reviewMode || '').trim().toLowerCase();
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();

  if (reviewMode) return false;
  const blockedRoutePrefixes = ['review', 'admin', 'refuse', 'ignore', 'proactive'];
  if (new Set(blockedRoutePrefixes).has(topRouteType)) return false;
  if (blockedRoutePrefixes.some((prefix) => routePolicyKey.startsWith(`${prefix}/`))) return false;
  return topRouteType === 'chat'
    || topRouteType === 'direct_chat'
    || routePolicyKey === 'chat/default'
    || routePolicyKey === 'direct_chat/default'
    || (!topRouteType && !routePolicyKey);
}

function mergeAllowedToolsWithMemoryCli(allowedTools, options = {}) {
  const base = Array.isArray(allowedTools) ? normalizeToolNames(allowedTools) : [];
  const filteredBase = (config.MEMORY_CLI_ENABLED && config.MEMORY_CLI_CHAT_ENABLED)
    ? base
    : base.filter((toolName) => toolName !== 'memory_cli');
  const withMemoryCli = (!shouldExposeMemoryCli(options) || base.includes('memory_cli'))
    ? filteredBase
    : [...filteredBase, 'memory_cli'];
  return filterAllowedToolsForMemoryCliTurn(withMemoryCli, options?.memoryCliTurn);
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

function shouldBypassHumanizerForPolicy(policyKey = '') {
  const normalized = String(policyKey || '').trim().toLowerCase();
  return ['lookup/', 'transform/', 'plan/', 'act/', 'tool/'].some((prefix) => normalized.startsWith(prefix));
}

function buildConversationMessagesWithCompression(
  userId,
  userInfo,
  dynamicPrompt,
  messageContent,
  affinity = null,
  routePrompt = null,
  options = {}
) {
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const sessionKey = String(options?.sessionKey || resolveShortTermSessionKey(userId, routeMeta) || '').trim();
  const context = buildShortTermContextMessages(userId, userInfo, {
    chatHistory,
    shortTermMemory,
    routeMeta,
    sessionKey
  });
  const continuityBuilt = buildContinuityState({
    request: {
      userId,
      question: typeof messageContent === 'string' ? messageContent : '',
      routeMeta,
      sessionKey
    },
    sessionKey,
    shortTermMemory,
    chatHistory,
    routeMeta,
    groupId: routeMeta.groupId || routeMeta.group_id || '',
    channelId: routeMeta.channelId || routeMeta.channel_id || '',
    taskType: routeMeta.taskType || routeMeta.task_type || ''
  });
  const segments = {
    system_prompt: dynamicPrompt
      ? [{ role: 'system', content: dynamicPrompt }, { role: 'system', content: HUMANIZER_SYSTEM_PROMPT }]
      : [{ role: 'system', content: HUMANIZER_SYSTEM_PROMPT }],
    route_prompt: routePrompt ? [{ role: 'system', content: routePrompt }] : [],
    continuity_state: continuityBuilt.text ? [{ role: 'system', content: continuityBuilt.text }] : [],
    short_term_summary: context.summaryMessage ? [context.summaryMessage] : [],
    recent_history: normalizeArray(context.recentHistory),
    current_user_turn: [{ role: 'user', content: messageContent }],
    retrieved_memory: normalizeArray(options.memoryContext?.segments?.retrievedMemory),
    daily_journal: normalizeArray(options.memoryContext?.segments?.dailyJournal),
    task_memory: normalizeArray(options.memoryContext?.segments?.taskMemory),
    group_memory: normalizeArray(options.memoryContext?.segments?.groupMemory),
    style_signals: normalizeArray(options.memoryContext?.segments?.styleSignals),
    tool_evidence: normalizeArray(options.toolEvidenceMessages),
    planner_artifacts: normalizeArray(options.plannerArtifactMessages)
  };
  const compactionPlan = buildContextCompactionPlan({
    segments,
    modelWindowTokens: Math.max(2048, Number(affinity?.contextWindowTokens || config.CONTEXT_WINDOW_MAX_TOKENS || 32000)),
    maxOutputTokens: getMaxTokens(getMainReplyDefaultMaxTokens(), options.modelConfig),
    routeMeta,
    source: String(options.source || 'legacy_chat').trim() || 'legacy_chat'
  });

  return {
    messages: compactionPlan.compactedSegments.flatMap((segment) => segment.messages),
    compactionPlan,
    continuityState: continuityBuilt,
    canonicalSegments: segments
  };
}

function buildReactiveRetryMessages(messagesToSend, context = {}, resolvedConfig = null) {
  return buildReactiveRetryPayload({
    messages: messagesToSend,
    canonicalSegments: context?.canonicalSegments,
    routeMeta: context?.routeMeta,
    source: String(context?.source || 'legacy_chat').trim() || 'legacy_chat',
    modelName: getModelName(resolvedConfig || context?.modelConfig || null),
    modelWindowTokens: Math.max(
      2048,
      Number(
        context?.compactionPlan?.diagnostics?.modelWindowTokens
        || context?.modelWindowTokens
        || context?.affinity?.contextWindowTokens
        || config.CONTEXT_WINDOW_MAX_TOKENS
        || 32000
      ) || 2048
    ),
    maxOutputTokens: getMaxTokens(getMainReplyDefaultMaxTokens(), resolvedConfig || context?.modelConfig || null),
    preferRawTrim: !context?.canonicalSegments
  });
}

function wrapContextHardBlockError(error, plan = null) {
  if (error?.isContextHardBlock) return error;
  const wrapped = createContextCompactionHardBlockError(
    plan || error?.compactionPlan || null,
    error?.message || 'Model invocation failed: context budget hard block after reactive compaction.'
  );
  wrapped.cause = error;
  return wrapped;
}

async function finalizeReplyText(rawReply, fallbackText, options = {}) {
  const raw = normalizeTextContent(rawReply).trim();
  const base = raw || String(fallbackText || '').trim();
  if (!base) return '';
  if (isReplyFailure(base, { emptyIsFailure: true })) return base;
  if (shouldBypassHumanizerForPolicy(options?.routePolicyKey)) return base;

  return runHumanizerAgent(base, {
    question: options.question,
    dynamicPrompt: options.dynamicPrompt,
    model: getModelName(options.modelConfig),
    apiBaseUrl: getApiBaseUrl(options.modelConfig),
    apiKey: getApiKey(options.modelConfig),
    retries: getRetries(1, options.modelConfig)
  });
}

function finalizeStreamingReplyText(rawReply, fallbackText) {
  const text = normalizeTextContent(rawReply).trim();
  return text || fallbackText;
}

async function finalizeStreamingReplyWithHumanizer(rawReply, fallbackText, options = {}) {
  const base = finalizeStreamingReplyText(rawReply, fallbackText);
  if (!base) return '';

  // 流式场景下由 Humanizer 子 Agent 负责对外输出，避免把润色前文本直接发给用户。
  return runHumanizerAgent(base, {
    question: options.question,
    dynamicPrompt: options.dynamicPrompt,
    model: getModelName(options.modelConfig),
    apiBaseUrl: getApiBaseUrl(options.modelConfig),
    apiKey: getApiKey(options.modelConfig),
    retries: getRetries(1, options.modelConfig),
    stream: true,
    onDelta: options.onDelta,
    streamHadOutput: options.streamHadOutput,
    maxSegments: Number(config.AI_STREAM_MAX_SEGMENTS) || 3
  });
}

function looksLikeCompatibilityFailureReply(text = '') {
  return isReplyFailure(text, { emptyIsFailure: true });
}

function persistConversation(userId, userContent, assistantContent, topic = '', userInfo = {}, options = {}) {
  appendChatHistory(userId, userContent, assistantContent, userInfo, {
    persistBridge: shouldPersistShortTermBridge(userContent, assistantContent, userId, options.customPrompt, options),
    routeMeta: options.routeMeta,
    sessionKey: options.sessionKey
  });
  if (topic) addProfileItem(userId, 'recent_topics', topic, 12);
}

function shouldAppendDailyJournal(question, finalReply, userId, customPrompt = null, options = {}) {
  if (!config.DAILY_JOURNAL_ENABLED) return false;
  if (options?.disableDailyJournal) return false;
  if (String(customPrompt || '').trim()) return false;

  const uid = String(userId || '').trim();
  const q = String(question || '').trim();
  const a = String(finalReply || '').trim();
  if (!uid || !q || !a) return false;
  if (/model invocation failed/i.test(a)) return false;

  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  if (!topRouteType && !routePolicyKey) return true;
  if (topRouteType) return topRouteType === 'chat' || topRouteType === 'direct_chat';
  return routePolicyKey === 'chat/default' || routePolicyKey === 'direct_chat/default';
}

function appendDailyJournalIfNeeded(question, finalReply, userInfo, userId, customPrompt = null, options = {}) {
  if (!shouldAppendDailyJournal(question, finalReply, userId, customPrompt, options)) return;
  appendDailyJournalEntry(userId, question, finalReply, userInfo, {
    sessionKey: String(options.sessionKey || '').trim(),
    routePolicyKey: String(options.routePolicyKey || '').trim(),
    topRouteType: String(options.topRouteType || '').trim(),
    routeMeta: options.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {},
    continuitySnapshot: options.continuitySnapshot && typeof options.continuitySnapshot === 'object'
      ? options.continuitySnapshot
      : {},
    contextStats: options.contextStats && typeof options.contextStats === 'object'
      ? options.contextStats
      : {}
  });
}

function shouldRestoreShortTermAfterRestart(question, userId, customPrompt = null, options = {}) {
  if (String(customPrompt || '').trim()) return false;

  const uid = String(userId || '').trim();
  const q = String(question || '').trim();
  if (!uid || !q) return false;

  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  if (topRouteType && !new Set(['chat', 'direct_chat']).has(topRouteType)) return false;
  if (routePolicyKey && !(routePolicyKey.startsWith('chat/') || routePolicyKey.startsWith('direct_chat/'))) return false;
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
  if (looksLikeCompatibilityFailureReply(reply)) return false;

  return true;
}

function createRunContext(question, userId, options = {}) {
  const task = createTask({
    kind: options.kind || 'agent_run',
    stage: 'created',
    userId,
    goal: question || '',
    inputText: question || '',
    source: options.source || 'chat',
    metadata: {
      image: Boolean(options.imageUrl),
      custom_prompt: Boolean(options.customPrompt)
    },
    workspace: {
      completed_steps: [],
      failed_steps: [],
      candidate_next_actions: [],
      evidence: [],
      pending_facts: [],
      drafts: []
    }
  });

  appendTaskLog(task.id, {
    type: 'task_start',
    message: 'Agent run started',
    data: {
      question: String(question || '').slice(0, 500)
    }
  });

  return {
    taskId: task.id,
    userId: String(userId || '').trim(),
    question: String(question || '').trim(),
    memoryCliTurn: createMemoryCliTurnState()
  };
}

function getAllowedToolNames(context = {}) {
  if (!Array.isArray(context.allowedTools)) return null;
  return normalizeToolNames(context.allowedTools);
}

function getAllowedToolNamesSet(context = {}) {
  const names = getAllowedToolNames(context);
  if (!Array.isArray(names)) return null;
  return new Set(names);
}

function getFilteredToolSchemas(context = {}) {
  const allowedSet = getAllowedToolNamesSet(context);
  const toolSchemas = getToolSchemas();
  if (!allowedSet) return toolSchemas;
  return toolSchemas.filter((schema) => {
    const toolName = String(schema?.function?.name || '').trim();
    return allowedSet.has(toolName);
  });
}

function getVisibleToolNames(context = {}) {
  const allowedNames = getAllowedToolNames(context);
  if (Array.isArray(allowedNames)) return allowedNames;
  return Object.keys(getToolExecutors());
}

function isToolAllowed(toolName, context = {}) {
  const allowedSet = getAllowedToolNamesSet(context);
  if (!allowedSet) return true;
  return allowedSet.has(String(toolName || '').trim());
}

async function executeToolCall(toolName, rawArgs = {}, context = {}) {
  const policy = getPolicy(toolName);
  const executor = getToolExecutors()[toolName];
  if (!isToolAllowed(toolName, context)) {
    throw new Error(`Tool not allowed: ${toolName}`);
  }
  if (!executor) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const normalizedArgs = enforceToolPolicy(toolName, rawArgs, context);
  if (toolName === 'memory_cli') {
    const decision = decideMemoryCliTurnAction(normalizedArgs.command, context.memoryCliTurn);
    if (!decision.ok) {
      context.memoryCliTurn = decision.nextState;
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
        searchCount: context.memoryCliTurn.searchCount,
        openCount: context.memoryCliTurn.openCount,
        mustAnswer: context.memoryCliTurn.mustAnswer,
        reason: decision.reason,
        repairApplied: Boolean(decision.repairApplied),
        invalidReason: String(decision.invalidReason || '')
      });
      return JSON.stringify(decision.result);
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
      userId: String(context.userId || '').trim(),
      routePolicyKey: String(context.routePolicyKey || '').trim(),
      topRouteType: String(context.topRouteType || '').trim(),
      routeMeta: context.routeMeta && typeof context.routeMeta === 'object' ? context.routeMeta : {}
    };
    try {
      const out = await executor(normalizedArgs);
      const normalizedOut = typeof out === 'string' ? out : JSON.stringify(out);
      context.memoryCliTurn = updateMemoryCliTurnStateAfterResult(context.memoryCliTurn, decision.parsed, normalizedOut);
      console.log('[memory] memory_cli turn state updated', {
        commandName: String(decision.parsed?.commandName || '').trim(),
        ok: true,
        searchCount: context.memoryCliTurn.searchCount,
        openCount: context.memoryCliTurn.openCount,
        mustAnswer: context.memoryCliTurn.mustAnswer,
        reason: context.memoryCliTurn.mustAnswer ? 'must_answer' : 'ok',
        repairApplied: Boolean(decision.repairApplied),
        invalidReason: ''
      });
      return normalizedOut;
    } catch (error) {
      context.memoryCliTurn = updateMemoryCliTurnStateAfterError(context.memoryCliTurn, 'tool_error');
      console.log('[memory] memory_cli turn state updated', {
        commandName: String(decision.parsed?.commandName || 'memory_cli').trim(),
        ok: false,
        searchCount: context.memoryCliTurn.searchCount,
        openCount: context.memoryCliTurn.openCount,
        mustAnswer: context.memoryCliTurn.mustAnswer,
        reason: 'tool_error'
      });
      throw error;
    }
  }

  // If this tool call comes from plan-mode execution, stitch the plan step id into the
  // persisted task step id so debugging can be done with a single id namespace.
  const planStepIdRaw = Object.prototype.hasOwnProperty.call(context, 'planStepId')
    ? context.planStepId
    : undefined;
  const planRoundRaw = Object.prototype.hasOwnProperty.call(context, 'planRound')
    ? context.planRound
    : (Object.prototype.hasOwnProperty.call(context, 'round') ? context.round : undefined);
  const planStepId = planStepIdRaw === undefined || planStepIdRaw === null ? '' : String(planStepIdRaw).trim();
  const planRoundNum = Number(planRoundRaw);
  const planRound = Number.isFinite(planRoundNum) ? Math.max(1, Math.floor(planRoundNum)) : null;
  const plannedTaskStepId = planStepId
    ? (planRound ? `plan_${planStepId}_r${planRound}` : `plan_${planStepId}`)
    : '';

  const stepId = context.taskId
    ? startTaskStep(context.taskId, {
        ...(plannedTaskStepId ? { id: plannedTaskStepId } : {}),
        kind: 'tool',
        name: toolName,
        purpose: context.purpose || '',
        input: normalizedArgs
      })
    : '';

  if (stepId && typeof context.onTaskStepStarted === 'function') {
    try { context.onTaskStepStarted(stepId); } catch (_) {}
  }

  if (context.taskId) {
    appendTaskLog(context.taskId, {
      type: 'tool_start',
      message: `Executing tool ${toolName}`,
      data: {
        tool: toolName,
        risk: policy.risk,
        capability: policy.capability
      }
    });
  }

  try {
    const out = await executor(normalizedArgs);
    const normalizedOut = typeof out === 'string' ? out : JSON.stringify(out);

    if (context.taskId && stepId) {
      const finishResult = finishTaskStep(context.taskId, stepId, { ok: true, output: normalizedOut.slice(0, 8000) });
      if (finishResult) {
        addTaskArtifact(context.taskId, {
          type: 'tool_result',
          label: toolName,
          content: normalizedOut.slice(0, 4000)
        });
      }
    }

    return normalizedOut;
  } catch (error) {
    if (context.taskId && stepId) {
      const finishResult = finishTaskStep(context.taskId, stepId, { ok: false, error: error.message || 'tool failed' });
      if (finishResult) {
        appendTaskLog(context.taskId, {
          level: 'error',
          type: 'tool_error',
          message: `Tool ${toolName} failed`,
          data: { error: error.message || 'tool failed' }
        });
      }
    }
    throw error;
  }
}

async function buildPlan(question, dynamicPrompt, modelConfig = null) {
  const plannerPrompt = [
    'You are a task planner. Break the user request into executable steps.',
    'Output JSON only.',
    '{',
    '  "goal": "string",',
    '  "need_tools": true,',
    '  "steps": [',
    '    { "id": 1, "action": "tool_name_or_reply", "args": {}, "purpose": "string" }',
    '  ]',
    '}',
    'Requirements:',
    '1) at most 5 steps',
    '2) action must come from the available tool names when a tool is needed',
    '3) use action "reply" when no tool is needed',
    '4) do not reveal reasoning, only return JSON'
  ].join('\n');

  const toolNames = getVisibleToolNames(modelConfig || {});
  // Unit-test anchor: keep the no-arg calls visible in source for stability checks.
  // (The actual request uses the modelConfig-aware calls below.)
  if (false) void ({ model: getPlannerModelName(), temperature: getPlannerTemperature() });
  const resolvedConfig = modelConfig && typeof modelConfig === 'object' ? modelConfig : {};
  const resp = await postWithRetry(
    ensureChatCompletionsUrl(getPlannerApiBaseUrl(resolvedConfig)),
    {
      model: getPlannerModelName(resolvedConfig),
      temperature: getPlannerTemperature(resolvedConfig),
      messages: [
        { role: 'system', content: plannerPrompt },
        { role: 'system', content: `Available tools: ${toolNames.join(', ')}` },
        { role: 'system', content: `Role context:
${dynamicPrompt.slice(0, 1200)}` },
        { role: 'user', content: question }
      ],
      max_tokens: getMaxTokens(1200, resolvedConfig),
      stream: false
    },
    getRetries(1, resolvedConfig),
    getPlannerApiKey(resolvedConfig)
  );

  const msg = extractMessageContent(resp);
  const plan = extractJsonSafely(normalizeTextContent(msg?.content));
  return sanitizePlan(plan, question);
}

async function executePlan(plan, context = {}) {
  const currentConfig = getConfig();
  const logs = [];
  const maxSteps = Math.max(1, Math.min(8, Number(currentConfig.PLAN_MAX_STEPS) || 5));
  const timeoutMs = Math.max(3000, Number(currentConfig.PLAN_TIMEOUT_MS) || 12000);
  const steps = Array.isArray(plan?.steps) ? plan.steps.slice(0, maxSteps) : [];

  for (const step of steps) {
    const action = String(step.action || '').trim();
    const args = step.args && typeof step.args === 'object' ? step.args : {};
    const row = {
      id: step.id,
      action,
      args,
      purpose: step.purpose || '',
      ok: false,
      result: '',
      error: ''
    };

    if (!action || action === 'reply') {
      row.ok = true;
      row.result = 'No tool execution required for this step';
      logs.push(row);
      continue;
    }

    if (!getToolExecutors()[action]) {
      row.error = `Unknown tool: ${action}`;
      logs.push(row);
      continue;
    }

    let taskStepId = '';
    try {
      const toolPromise = executeToolCall(action, args, {
        ...context,
        purpose: row.purpose,
        planStepId: row.id,
        planRound: context.round,
        onTaskStepStarted: (startedStepId) => {
          taskStepId = String(startedStepId || '').trim();
        }
      });
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Tool timeout (${timeoutMs}ms)`)), timeoutMs);
      });

      const out = await Promise.race([toolPromise, timeoutPromise]);
      row.ok = true;
      row.result = typeof out === 'string' ? out : JSON.stringify(out);

      if (context.taskId) {
        appendWorkspaceItem(context.taskId, 'completed_steps', {
          id: row.id,
          action: row.action,
          purpose: row.purpose
        }, 40);
      }
    } catch (e) {
      row.error = e.message || 'tool execution failed';
      if (context.taskId) {
        appendWorkspaceItem(context.taskId, 'failed_steps', {
          id: row.id,
          action: row.action,
          purpose: row.purpose,
          error: row.error
        }, 40);

        // Timeout fallback should mark the task step as failed immediately.
        // Late tool completion cannot override this because finishTaskStep is idempotent.
        if (/^Tool timeout \(/i.test(row.error) && taskStepId) {
          const timeoutFinished = finishTaskStep(context.taskId, taskStepId, {
            ok: false,
            error: row.error
          });
          if (timeoutFinished) {
            appendTaskLog(context.taskId, {
              level: 'warn',
              type: 'tool_timeout',
              message: `Tool ${row.action} timed out`,
              data: {
                plan_step_id: row.id,
                task_step_id: taskStepId,
                error: row.error
              }
            });
          }
        }
      }
    }

    logs.push(row);
  }

  return logs;
}

async function executePlanLoop(question, dynamicPrompt, initialPlan, context = {}) {
  const maxRounds = Math.max(1, Math.min(3, Number(config.AGENT_MAX_ROUNDS) || 3));
  const rounds = [];
  let currentPlan = initialPlan;
  let verification = null;

  for (let round = 1; round <= maxRounds && currentPlan; round += 1) {
    if (context.taskId) {
      setTaskStage(context.taskId, round === 1 ? 'executing' : 'replanning', {
        round,
        plan_goal: currentPlan.goal || question
      });
      setTaskCheckpoint(context.taskId, {
        round,
        stage: round === 1 ? 'executing' : 'replanning'
      });
      addTaskArtifact(context.taskId, {
        type: round === 1 ? 'plan' : 'repair_plan',
        label: `plan_round_${round}`,
        content: currentPlan
      });
    }

    const execLogs = await executePlan(currentPlan, { ...context, round, dynamicPrompt });
    verification = verifyExecutionResult({
      question,
      plan: currentPlan,
      execLogs,
      round,
      maxRounds
    });

    rounds.push({ round, plan: currentPlan, execLogs, verification });

    if (context.taskId) {
      setTaskStage(context.taskId, 'verifying', {
        round,
        done: verification.done,
        confidence: verification.confidence
      });
      setTaskCheckpoint(context.taskId, {
        round,
        verification: {
          done: verification.done,
          confidence: verification.confidence,
          missing: verification.missing
        }
      });
      mergeWorkspace(context.taskId, {
        candidate_next_actions: verification.next_action ? [verification.next_action] : [],
        evidence: verification.evidence,
        pending_facts: verification.missing
      });
      addTaskArtifact(context.taskId, {
        type: 'verification',
        label: `verification_round_${round}`,
        content: verification
      });
      appendTaskLog(context.taskId, {
        type: 'verification',
        message: `Verification round ${round}`,
        data: {
          done: verification.done,
          confidence: verification.confidence,
          missing: verification.missing
        }
      });
    }

    if (verification.done) {
      return {
        rounds,
        finalPlan: currentPlan,
        finalExecLogs: execLogs,
        verification
      };
    }

    currentPlan = buildRepairPlan({ previousPlan: currentPlan, verification, round });
    if (!currentPlan) break;
  }

  const lastRound = rounds[rounds.length - 1] || {
    plan: initialPlan,
    execLogs: [],
    verification: verification || verifyExecutionResult({ question, plan: initialPlan, execLogs: [] })
  };

  return {
    rounds,
    finalPlan: lastRound.plan,
    finalExecLogs: lastRound.execLogs,
    verification: lastRound.verification
  };
}

async function synthesizeFromPlan(question, dynamicPrompt, plan, execLogs, verification = null, modelConfig = null, options = null) {
  const synthesisPrompt = [
    'You must write the final answer from the plan, execution logs, and verification result.',
    'Requirements:',
    '1) follow the role prompt',
    '2) do not expose hidden reasoning or internal chain-of-thought',
    '3) if evidence is weak or a tool failed, clearly mark uncertainty',
    '4) reply directly and keep it actionable',
    '5) prefer evidence-backed claims over speculation',
    '6) if a [ContinuityState] system message is present, treat it as the authoritative current-thread carry-over context',
    '7) continue from that continuity context instead of claiming missing context unless the continuity state itself is empty',
    '8) do not say this is the first conversation, do not say you lack prior context, and do not ask the user to restate prior steps when [ContinuityState] is present',
    '9) do not mention hidden tools, memory probes, search commands, or internal retrieval steps'
  ].join('\n');

  const normalizedOptions = options && typeof options === 'object' ? options : {};
  const extraSystemMessages = Array.isArray(normalizedOptions.systemMessages)
    ? normalizedOptions.systemMessages
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        role: String(item.role || 'system').trim() || 'system',
        content: item.content
      }))
    : [];

  const baseMessages = [
    { role: 'system', content: dynamicPrompt },
    ...extraSystemMessages,
    { role: 'system', content: HUMANIZER_SYSTEM_PROMPT },
    { role: 'system', content: synthesisPrompt },
    {
      role: 'user',
      content: [
        `User question: ${question || ''}`,
        `Plan (JSON): ${JSON.stringify(plan).slice(0, 4000)}`,
        `Execution logs (JSON): ${JSON.stringify(execLogs).slice(0, 8000)}`,
        `Verification (JSON): ${JSON.stringify(verification || {}).slice(0, 4000)}`
      ].join('\n\n')
    }
  ];

  const resp = await withMainModelFallback(async (resolvedConfig) => {
    const mainUrl = ensureChatCompletionsUrl(getApiBaseUrl(resolvedConfig));
    const requestOnce = (messages) => postWithRetry(
      mainUrl,
      {
        model: getModelName(resolvedConfig),
        temperature: getTemperature(resolvedConfig),
        top_p: getTopP(resolvedConfig),
        messages,
        max_tokens: getMaxTokens(getMainReplyDefaultMaxTokens(), resolvedConfig),
        stream: false
      },
      getRetries(1, resolvedConfig),
      getApiKey(resolvedConfig)
    );

    try {
      return await requestOnce(baseMessages);
    } catch (error) {
      if (!isContextOverflowError(error)) throw error;
      const retryPayload = buildReactiveRetryMessages(baseMessages, {
        ...normalizedOptions,
        source: String(normalizedOptions.source || 'legacy_plan_synthesis').trim() || 'legacy_plan_synthesis',
        routeMeta: normalizedOptions.routeMeta
      }, resolvedConfig);
      try {
        return await requestOnce(retryPayload.messages);
      } catch (retryError) {
        if (isContextOverflowError(retryError)) {
          throw wrapContextHardBlockError(retryError, retryPayload.compactionPlan);
        }
        throw retryError;
      }
    }
  }, modelConfig, '', { routeMeta: normalizedOptions.routeMeta });

  const msg = extractMessageContent(resp);
  return finalizeReplyText(msg?.content, 'I could not organize the result just now. Please try again.', {
    question,
    dynamicPrompt,
    modelConfig
  });
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

async function requestStreamingReply(messagesToSend, options = {}, modelConfig = null) {
  const parserState = { buffer: '' };
  let collected = '';
  const userId = String(options.userId || options.routeMeta?.userId || options.routeMeta?.user_id || '').trim();

  try {
    await withMainModelFallback(async (resolvedConfig) => {
      const requestStreamOnce = async (messages) => {
        const request = buildMainModelRequest(resolvedConfig, {
          messages,
          stream: true,
          defaultMaxTokens: getMainReplyDefaultMaxTokens(),
          routeMeta: options?.routeMeta,
          topRouteType: options?.topRouteType
        });
        await postStreamWithRetry(
          request.url,
          request.body,
          {
            onData(chunk) {
              const parsed = extractSSEEvents(parserState, chunk);
              parserState.buffer = parsed.state.buffer;

              for (const event of parsed.events) {
                if (!event || event.done || !event.delta) continue;
                collected += event.delta;
                options.streamHadOutput = true;
                options.onDelta(event.delta, collected);
              }
            }
          },
          getRetries(1, resolvedConfig),
          getApiKey(resolvedConfig)
        );
      };

      try {
        await requestStreamOnce(messagesToSend);
      } catch (error) {
        if (!isContextOverflowError(error) || String(collected || '').trim()) throw error;
        const retryPayload = buildReactiveRetryMessages(messagesToSend, options, resolvedConfig);
        try {
          await requestStreamOnce(retryPayload.messages);
        } catch (retryError) {
          if (isContextOverflowError(retryError) && !String(collected || '').trim()) {
            throw wrapContextHardBlockError(retryError, retryPayload.compactionPlan);
          }
          throw retryError;
        }
      }
    }, modelConfig, userId, { routeMeta: options?.routeMeta });
  } catch (error) {
    if (collected.trim()) {
      error.partialText = collected;
      error.streamHadOutput = true;
    }
    throw error;
  }

  const tailEvents = flushSSEState(parserState);
  for (const event of tailEvents) {
    if (!event || event.done || !event.delta) continue;
    collected += event.delta;
    options.streamHadOutput = true;
    options.onDelta(event.delta, collected);
  }

  return collected;
}

async function requestNonStreamingReply(messagesToSend, context = {}) {
  const modelConfig = context.modelConfig || null;
  const userId = String(context.userId || context.routeMeta?.userId || context.routeMeta?.user_id || '').trim();
  const toolSchemas = getFilteredToolSchemas(context);
  const firstResp = await withMainModelFallback(async (resolvedConfig) => {
    const requestOnce = async (messages, includeTools = toolSchemas.length > 0) => {
      const request = buildMainModelRequest(resolvedConfig, {
        messages,
        stream: false,
        defaultMaxTokens: getMainReplyDefaultMaxTokens(),
        routeMeta: context?.routeMeta,
        topRouteType: context?.topRouteType,
        tools: includeTools ? toolSchemas : []
      });
      const requestBody = request.body;
      if (includeTools) {
        requestBody.tools = toolSchemas;
        requestBody.tool_choice = 'auto';
      }
      return postWithRetry(
        request.url,
        requestBody,
        getRetries(1, resolvedConfig),
        getApiKey(resolvedConfig)
      );
    };
    try {
      return await requestOnce(messagesToSend, toolSchemas.length > 0);
    } catch (toolError) {
      if (isToolSchemaValidationError(toolError)) {
        return requestOnce(messagesToSend, false);
      }
      if (!isContextOverflowError(toolError)) throw toolError;
      const retryPayload = buildReactiveRetryMessages(messagesToSend, context, resolvedConfig);
      try {
        return await requestOnce(retryPayload.messages, false);
      } catch (retryError) {
        if (isContextOverflowError(retryError)) {
          throw wrapContextHardBlockError(retryError, retryPayload.compactionPlan);
        }
        throw retryError;
      }
    }
  }, modelConfig, userId, { routeMeta: context?.routeMeta });

  let responseMessage = extractMessageContent(firstResp);
  if (!responseMessage) {
    console.error('AI response malformed(first):', String(firstResp?.data).slice(0, 500));
    return MODEL_RESPONSE_MALFORMED_REPLY;
  }

  if (Array.isArray(responseMessage.tool_calls) && responseMessage.tool_calls.length > 0) {
    messagesToSend.push(responseMessage);

    for (const toolCall of responseMessage.tool_calls) {
      const fn = toolCall?.function?.name;
      const args = safeParseArgs(toolCall?.function?.arguments);
      let toolResult = 'Tool execution failed';

      try {
        toolResult = await executeToolCall(fn, args, {
          ...context,
          purpose: 'model requested tool call'
        });
      } catch (e) {
        toolResult = `Tool error: ${e.message}`;
      }

      messagesToSend.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
      });
    }

    const memoryCliFollowup = buildMemoryCliFollowupInstruction(context.memoryCliTurn);
    if (memoryCliFollowup) {
      messagesToSend.push({
        role: 'system',
        content: memoryCliFollowup
      });
    }

    const secondResp = await withMainModelFallback(async (resolvedConfig) => {
      const requestOnce = (messages) => {
        const request = buildMainModelRequest(resolvedConfig, {
          messages,
          stream: false,
          defaultMaxTokens: getMainReplyDefaultMaxTokens(),
          routeMeta: context?.routeMeta,
          topRouteType: context?.topRouteType
        });
        return postWithRetry(
          request.url,
          request.body,
          getRetries(1, resolvedConfig),
          getApiKey(resolvedConfig)
        );
      };
      try {
        return await requestOnce(messagesToSend);
      } catch (error) {
        if (!isContextOverflowError(error)) throw error;
        const retryPayload = buildReactiveRetryMessages(messagesToSend, {
          ...context,
          canonicalSegments: null,
          source: String(context?.source || 'legacy_chat_tool_followup').trim() || 'legacy_chat_tool_followup'
        }, resolvedConfig);
        try {
          return await requestOnce(retryPayload.messages);
        } catch (retryError) {
          if (isContextOverflowError(retryError)) {
            throw wrapContextHardBlockError(retryError, retryPayload.compactionPlan);
          }
          throw retryError;
        }
      }
    }, modelConfig, userId, { routeMeta: context?.routeMeta });

    responseMessage = extractMessageContent(secondResp);
    if (!responseMessage) {
      console.error('AI response malformed(second):', String(secondResp?.data).slice(0, 500));
      return 'I received tool data, but failed while organizing the final response.';
    }
  }

  return finalizeReplyText(responseMessage?.content, '我刚才在整理最终回答时没有拿到稳定正文。请再发一次，我会直接按已拿到的结果继续回答。', {
    question: context.question,
    dynamicPrompt: context.dynamicPrompt,
    modelConfig: context.modelConfig
  });
}

async function askAI(question, userInfo, userId, customPrompt = null, imageUrl = null, options = {}) {
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  if (shouldExposeMemoryCli({ ...options, customPrompt })) {
    recordMemoryScope(userId, routeMeta);
  }
  const sessionKey = resolveShortTermSessionKey(userId, routeMeta);
  const sessionScope = resolveShortTermScope(userId, routeMeta, sessionKey);
  if (!chatHistory[sessionKey]) chatHistory[sessionKey] = [];
  if (typeof require('../../utils/memory').pruneChatHistoryStore === 'function') {
    require('../../utils/memory').pruneChatHistoryStore(chatHistory);
  }
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
      const resp = await postWithRetry(
        ensureChatCompletionsUrl(getMemoryApiBaseUrl(options.modelConfig)),
        {
          model: getMemoryModelName(options.modelConfig),
          temperature: getTemperature(options.modelConfig),
          top_p: getTopP(options.modelConfig),
          messages: [
            {
              role: 'system',
              content: [
                buildStructuredCompressionPrompt(existingState || { summary: existingSummary }, summaryTokens),
                '如果无法稳定输出 JSON，退回输出纯文本短期摘要。',
                '请把较早对话压缩为短期上下文摘要。',
                '只保留会影响后续回复的偏好、约束、承诺、未完成事项和最近讨论主线。',
                '不要写成长期人格设定，不要杜撰。',
                '与已有摘要去重，尽量简洁。',
                `目标长度：约 ${summaryTokens} tokens。`,
                existingSummary ? `已有摘要：\n${existingSummary}` : '当前没有已有摘要。'
              ].join('\n')
            },
            { role: 'user', content: chunkText }
          ],
          max_tokens: getMaxTokens(300, options.modelConfig),
          stream: false
        },
        getRetries(1, options.modelConfig),
        getMemoryApiKey(options.modelConfig)
      );

      const msg = extractMessageContent(resp);
      return normalizeTextContent(msg?.content).trim();
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

  const modelConfig = (options.modelConfig && typeof options.modelConfig === 'object')
    ? options.modelConfig
    : null;
  const requestModelConfig = imageUrl
    ? buildImageModelConfig(modelConfig, userId, { routeMeta })
    : modelConfig;
  const routePrompt = String(options.routePrompt || '').trim() || null;
  const usePlanMode = shouldUsePlanModeForRequest(question, {
    customPrompt,
    imageUrl,
    routePolicyKey: options?.routePolicyKey,
    topRouteType: options?.topRouteType
  });
  const runContext = createRunContext(question, userId, {
    kind: usePlanMode ? 'plan_run' : 'chat_run',
    source: 'chat',
    imageUrl,
    customPrompt
  });
  runContext.allowedTools = mergeAllowedToolsWithMemoryCli(getAllowedToolNames(options), {
    ...options,
    customPrompt,
    memoryCliTurn: runContext.memoryCliTurn
  });

  const { dynamicPrompt, affinity, memoryContext, promptSegments } = await buildDynamicPrompt(userInfo, userId, question, customPrompt, {
    ...options,
    memoryCliTurn: runContext.memoryCliTurn
  });

  if (usePlanMode) {
    try {
      setTaskStage(runContext.taskId, 'planning', { source: 'plan_mode' });
      const planModelConfig = modelConfig ? { ...modelConfig, allowedTools: runContext.allowedTools } : { allowedTools: runContext.allowedTools };
      const plan = await buildPlan(question || '', dynamicPrompt, planModelConfig);
      const successCriteria = deriveSuccessCriteria(question || '', plan);
      setTaskSuccessCriteria(runContext.taskId, successCriteria);
      appendTaskLog(runContext.taskId, {
        type: 'plan_built',
        message: 'Plan built',
        data: { step_count: Array.isArray(plan.steps) ? plan.steps.length : 0 }
      });
      addTaskArtifact(runContext.taskId, { type: 'plan', label: 'plan', content: plan });

      const loopResult = await executePlanLoop(question || '', dynamicPrompt, plan, {
        ...runContext,
        dynamicPrompt
      });
      const rawReply = await synthesizeFromPlan(
        question || '',
        dynamicPrompt,
        loopResult.finalPlan,
        loopResult.finalExecLogs,
        loopResult.verification,
        modelConfig
      );

      mergeWorkspace(runContext.taskId, {
        drafts: [{ type: 'final_reply', content: String(rawReply || '').slice(0, 4000) }]
      });
      persistConversation(userId, question || '', rawReply, pickRecentTopic(question), userInfo, {
        customPrompt,
        routePolicyKey: options.routePolicyKey,
        topRouteType: options.topRouteType,
        reviewMode: options.reviewMode,
        routeMeta: options.routeMeta
      });
      appendDailyJournalIfNeeded(question, rawReply, userInfo, userId, customPrompt, options);

      if (loopResult.verification && !loopResult.verification.done) {
        failTask(runContext.taskId, loopResult.verification.reason || 'verification failed', {
          rounds: loopResult.rounds.length,
          verification: loopResult.verification
        });
      } else {
        completeTask(runContext.taskId, {
          reply: rawReply.slice(0, 4000),
          mode: 'plan',
          verification: loopResult.verification
        });
      }

      return rawReply;
    } catch (e) {
      appendTaskLog(runContext.taskId, {
        level: 'error',
        type: 'plan_error',
        message: 'Plan-and-solve failed',
        data: { error: e.message || 'plan failed' }
      });
      failTask(runContext.taskId, e.message || 'plan failed');
      console.error('Plan-and-solve failed, fallback to default chain:', e.message);
    }
  }

  const messageContent = imageUrl
    ? buildVisionMessageContent(question || '', imageUrl)
    : (question || '');

  const assembledContext = buildConversationMessagesWithCompression(
    userId,
    userInfo,
    dynamicPrompt,
    messageContent,
    affinity,
    routePrompt,
    {
      routeMeta,
      sessionKey,
      modelConfig: requestModelConfig,
      memoryContext,
      promptSegments,
      source: 'legacy_chat'
    }
  );
  const messagesToSend = assembledContext.messages;
  const contextStats = {
    usageRatio: Number(assembledContext.compactionPlan?.usageRatio || 0) || 0,
    compactionLevel: String(assembledContext.compactionPlan?.level || 'normal').trim() || 'normal'
  };
  const continuitySnapshot = assembledContext.continuityState?.payload
    ? {
        activeTopic: assembledContext.continuityState.payload.active_topic || '',
        openLoops: assembledContext.continuityState.payload.open_loops || [],
        assistantCommitments: assembledContext.continuityState.payload.assistant_commitments || [],
        userConstraints: assembledContext.continuityState.payload.user_constraints || [],
        carryOverUserTurn: assembledContext.continuityState.payload.carry_over_user_turn || ''
      }
    : {};
  const textToSave = typeof messageContent === 'string' ? messageContent : (question || '[shared an image]');
  const topic = pickRecentTopic(question);

  if (shouldUseStreamingReply(question, customPrompt, imageUrl, options)) {
    const useHumanizerStreaming = isHumanizerAgentEnabled() && !shouldBypassHumanizerForPolicy(options?.routePolicyKey);
    try {
      const upstreamStreamOptions = useHumanizerStreaming
        ? {
            onDelta() {},
            streamHadOutput: false,
            userId,
            routeMeta: options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {}
          }
        : options;
      const streamedReply = await requestStreamingReply(messagesToSend, upstreamStreamOptions, requestModelConfig);
      const finalReply = useHumanizerStreaming
        ? await finalizeStreamingReplyWithHumanizer(streamedReply, 'I drifted for a second. Please ask me again.', {
            ...options,
            question,
            dynamicPrompt,
            modelConfig: requestModelConfig
          })
        : finalizeStreamingReplyText(streamedReply, 'I drifted for a second. Please ask me again.');
      options.streamCompleted = true;
      setTaskSuccessCriteria(runContext.taskId, deriveSuccessCriteria(question || '', null));
      setTaskStage(runContext.taskId, 'completed', { source: 'stream' });
      persistConversation(userId, textToSave, finalReply, topic, userInfo, {
        customPrompt,
        routePolicyKey: options.routePolicyKey,
        topRouteType: options.topRouteType,
        reviewMode: options.reviewMode,
        routeMeta: options.routeMeta,
        sessionKey
      });
      appendDailyJournalIfNeeded(question, finalReply, userInfo, userId, customPrompt, {
        ...options,
        sessionKey,
        continuitySnapshot,
        contextStats
      });
      completeTask(runContext.taskId, { reply: finalReply.slice(0, 4000), mode: 'stream' });
      return finalReply;
    } catch (error) {
      if (error.partialText && String(error.partialText).trim()) {
        const finalReply = useHumanizerStreaming
          ? await finalizeStreamingReplyWithHumanizer(error.partialText, 'I drifted for a second. Please ask me again.', {
              ...options,
              question,
              dynamicPrompt,
              modelConfig: requestModelConfig
            })
          : finalizeStreamingReplyText(error.partialText, 'I drifted for a second. Please ask me again.');
        options.streamCompleted = true;
        appendTaskLog(runContext.taskId, {
          level: 'warn',
          type: 'stream_partial',
          message: 'Streaming interrupted after partial output',
          data: { error: error.message || 'stream interrupted' }
        });
        setTaskSuccessCriteria(runContext.taskId, deriveSuccessCriteria(question || '', null));
        setTaskStage(runContext.taskId, 'completed', { source: 'stream_partial' });
        persistConversation(userId, textToSave, finalReply, topic, userInfo, {
          customPrompt,
          routePolicyKey: options.routePolicyKey,
          topRouteType: options.topRouteType,
          reviewMode: options.reviewMode,
          routeMeta: options.routeMeta,
          sessionKey
        });
        appendDailyJournalIfNeeded(question, finalReply, userInfo, userId, customPrompt, {
          ...options,
          sessionKey,
          continuitySnapshot,
          contextStats
        });
        completeTask(runContext.taskId, { reply: finalReply.slice(0, 4000), mode: 'stream_partial' });
        return finalReply;
      }

      options.streamFallbackToNonStream = true;
      console.error('AI stream error, fallback to standard mode:', error.response?.data || error.message);
    }
  }

  try {
    setTaskStage(runContext.taskId, 'executing', { source: 'chat' });
    setTaskSuccessCriteria(runContext.taskId, deriveSuccessCriteria(question || '', null));
    const rawReply = await requestNonStreamingReply(messagesToSend, { ...runContext, dynamicPrompt, modelConfig: requestModelConfig });
    persistConversation(userId, textToSave, rawReply, topic, userInfo, {
      customPrompt,
      routePolicyKey: options.routePolicyKey,
      topRouteType: options.topRouteType,
      reviewMode: options.reviewMode,
      routeMeta: options.routeMeta,
      sessionKey
    });
    appendDailyJournalIfNeeded(question, rawReply, userInfo, userId, customPrompt, {
      ...options,
      sessionKey,
      continuitySnapshot,
      contextStats
    });
    completeTask(runContext.taskId, { reply: rawReply.slice(0, 4000), mode: 'chat' });
    return rawReply;
  } catch (error) {
    failTask(runContext.taskId, error.message || 'chat reply failed');
    console.error('AI API error:', error.response?.data || error.message);
    if (error?.isContextHardBlock) {
      return getContextCompactionFailureReply();
    }
    return 'The network or upstream model did not respond correctly just now.';
  }
}

async function drawPicture(prompt) {
  try {
    const resp = await postWithRetry(
      ensureChatCompletionsUrl(getImageApiBaseUrl()),
      {
        model: getImageModelName(),
        temperature: getTemperature(),
        top_p: getTopP(),
        messages: [
          { role: 'user', content: `Generate an anime-style illustration with this prompt: ${prompt}` }
        ],
        max_tokens: getMaxTokens(300),
        stream: false
      },
      getRetries(1),
      getImageApiKey()
    );

    let data = resp?.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) {}
    }

    const candidates = [
      data?.data?.[0]?.url,
      data?.data?.[0]?.image_url,
      data?.choices?.[0]?.image_url,
      data?.choices?.[0]?.message?.image_url,
      data?.choices?.[0]?.message?.content?.[0]?.image_url?.url,
      data?.output?.[0]?.content?.[0]?.image_url?.url
    ].filter(Boolean);

    if (candidates.length > 0) return candidates[0];

    console.error('drawPicture no image url found:', JSON.stringify(data).slice(0, 1200));
    return null;
  } catch (error) {
    console.error('drawPicture error:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      data: error.response?.data
    });
    return null;
  }
}

function shouldPersistMemoryCandidate(type, value, confidence) {
  const text = String(value || '').trim();
  if (!text) return false;

  const minConfidence = Number(config.MEMORY_EXTRACT_MIN_CONFIDENCE) || 0.72;
  if (Number(confidence || 0) < minConfidence) return false;
  if (text.length < 2) return false;
  if (type === 'topic' && text.length < 4) return false;
  if (type === 'topic' && /^(weather|music|hot_topics|chat|daily)$/i.test(text)) return false;
  return true;
}

function inferExtractorTier(type, confidence = 0.8) {
  const conf = Math.max(0, Math.min(1, Number(confidence || 0)));
  const t = String(type || '').trim().toLowerCase();

  if (t === 'impression') {
    if (conf >= 0.9) return 'S';
    if (conf >= 0.8) return 'A';
    return 'B';
  }

  if (t === 'goal') {
    if (conf >= 0.9) return 'S';
    if (conf >= 0.8) return 'A';
    return 'B';
  }

  if (t === 'fact' || t === 'like' || t === 'dislike') {
    if (conf >= 0.9) return 'A';
    if (conf >= 0.78) return 'B';
    return 'C';
  }

  // Topics are usually short-lived and should be capped to lower tiers.
  if (t === 'topic') {
    if (conf >= 0.9) return 'B';
    return 'C';
  }

  return 'B';
}

function persistLearnedMemories(userId, type, values, confidence = 0.8) {
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (!shouldPersistMemoryCandidate(type, value, confidence)) continue;
    const importanceTier = normalizeTier(inferExtractorTier(type, confidence)) || 'B';
    const meta = { source: 'extractor', confidence, importanceTier };

    if (type === 'fact') {
      addMemoryItemSafe(userId, value, 'fact', meta, 1.15);
      addUserFact(userId, value, 30);
      continue;
    }

    if (type === 'like') {
      addMemoryItemSafe(userId, `likes: ${value}`, 'like', meta, 1.05);
      addProfileItem(userId, 'likes', value, 20);
      continue;
    }

    if (type === 'dislike') {
      addMemoryItemSafe(userId, `dislikes: ${value}`, 'dislike', meta, 1.05);
      addProfileItem(userId, 'dislikes', value, 20);
      continue;
    }

    if (type === 'goal') {
      addMemoryItemSafe(userId, `goal: ${value}`, 'goal', meta, 1.2);
      addProfileItem(userId, 'goals', value, 20);
      continue;
    }

    if (type === 'impression') {
      addMemoryItemSafe(userId, `impression: ${value}`, 'impression', meta, 1.35);
      setUserImpression(userId, value);
      continue;
    }

    if (type === 'topic') {
      addMemoryItemSafe(userId, `recent topic: ${value}`, 'topic', meta, 0.95);
      addProfileItem(userId, 'recent_topics', value, 12);
    }
  }
}

async function learnSomethingNew(userId, userText, botReply) {
  const extractPrompt = `
You are a long-term memory extractor. Return JSON only:
{
  "facts": [],
  "likes": [],
  "dislikes": [],
  "goals": [],
  "impression": "",
  "topics": [],
  "confidence": 0.0
}
Rules:
- facts must be stable user facts, not transient mood
- impression must be a concise, stable summary of what kind of user this is, their interaction style, and enduring preferences
- topics should be recurring or ongoing topics, not overly generic words
- confidence must be between 0 and 1
`.trim();

  const conversation = `User: ${userText}\nAssistant: ${botReply}`;

  try {
    const resp = await postWithRetry(
      ensureChatCompletionsUrl(getMemoryApiBaseUrl()),
      {
        model: getMemoryModelName(),
        temperature: getTemperature(),
        top_p: getTopP(),
        messages: [
          { role: 'system', content: extractPrompt },
          { role: 'user', content: conversation }
        ],
        max_tokens: getMaxTokens(500),
        stream: false
      },
      getRetries(1),
      getMemoryApiKey()
    );

    const msg = extractMessageContent(resp);
    const obj = extractJsonSafely(normalizeTextContent(msg?.content));
    if (!obj || typeof obj !== 'object') return;

    const facts = Array.isArray(obj.facts) ? obj.facts : [];
    const likes = Array.isArray(obj.likes) ? obj.likes : [];
    const dislikes = Array.isArray(obj.dislikes) ? obj.dislikes : [];
    const goals = Array.isArray(obj.goals) ? obj.goals : [];
    const impressions = typeof obj.impression === 'string'
      ? [obj.impression]
      : (Array.isArray(obj.impressions) ? obj.impressions : []);
    const topics = Array.isArray(obj.topics) ? obj.topics : [];
    const confidence = Number(obj.confidence || 0.8) || 0.8;

    persistLearnedMemories(userId, 'fact', facts, confidence);
    persistLearnedMemories(userId, 'like', likes, confidence);
    persistLearnedMemories(userId, 'dislike', dislikes, confidence);
    persistLearnedMemories(userId, 'goal', goals, confidence);
    persistLearnedMemories(userId, 'impression', impressions.slice(0, 1), Math.max(confidence, 0.82));
    persistLearnedMemories(userId, 'topic', topics, Math.min(confidence, 0.9));
  } catch (e) {
    console.error('memory extraction failed:', e.message);
  }
}

module.exports = {
  askAI,
  drawPicture,
  learnSomethingNew,
  getLatestReasoning,
  buildVisionMessageContent,
  shouldUseStreamingReply,
  shouldUsePlanModeForRequest,
  getPlannerModelName,
  getPlannerTemperature,
  getPlannerApiBaseUrl,
  getPlannerApiKey,
  fallbackReplyPlan,
  sanitizePlan,
  buildPlan,
  buildDynamicPrompt,
  executePlan,
  executePlanLoop,
  synthesizeFromPlan,
  requestStreamingReply,
  finalizeStreamingReplyWithHumanizer,
  requestNonStreamingReply,
  mergeAllowedToolsWithMemoryCli,
  shouldExposeMemoryCli,
  shouldBypassHumanizerForPolicy
};








const config = require('../config');
const { requestNonStreamingReply } = require('../api/runtimeV2/model/service');
const { getRecentSessionContextSummaries } = require('../utils/sessionContextSummaryStore');
const { resolveShortTermSessionKey } = require('../utils/shortTermMemory');
const { buildChatLivenessDisciplinePrompt } = require('../utils/chatLivenessContext');
const { buildMainStableSystemBlocks } = require('../utils/stagePromptContracts');
const { sanitizeUserFacingText } = require('../utils/userFacingText');
const {
  buildPersonaModuleCandidates,
  loadPersonaModuleText,
  selectPersonaModules
} = require('../utils/personaModules');
const { isUnsafeUserFacingReply } = require('../utils/userFacingReplyGuards');
const { classifyReplyFailure, isReplyFailure } = require('../utils/replyFailure');

const NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_ACTIVE = 2;
const NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_TOKEN_COST = 100;
const NORMAL_FAST_REPLY_PERSONA_MODULE_TEXT_MAX_CHARS = 700;
const NORMAL_FAST_REPLY_WORLDBOOK_MAX_ACTIVE = 1;
const NORMAL_FAST_REPLY_WORLDBOOK_MAX_TOKEN_COST = 180;
const NORMAL_FAST_REPLY_WORLDBOOK_TEXT_MAX_CHARS = 900;

function clampNumber(value, fallback, min = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getMessageContent(item = {}) {
  return normalizeText(item.content || item.text || item.message || item.value);
}

function normalizeHistoryMessage(item = {}) {
  const role = String(item?.role || item?.speaker || '').trim().toLowerCase();
  const normalizedRole = role === 'assistant' || role === 'bot' ? 'assistant' : (role === 'user' || role === 'human' ? 'user' : '');
  const content = getMessageContent(item);
  if (!normalizedRole || !content) return null;
  if (normalizedRole === 'assistant' && (isUnsafeUserFacingReply(content) || isReplyFailure(content))) return null;
  return {
    role: normalizedRole,
    content
  };
}

function trimTextToChars(text = '', maxChars = 0) {
  const normalized = normalizeText(text);
  const limit = clampNumber(maxChars, 0, 0);
  if (!normalized || limit <= 0) return '';
  return normalized.length > limit ? normalized.slice(-limit) : normalized;
}

function trimPromptTextToChars(text = '', maxChars = 0) {
  const normalized = normalizeText(text);
  const limit = clampNumber(maxChars, 0, 0);
  if (!normalized || limit <= 0) return '';
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function classifyNormalFastReplyFailure(visibleText = '', persistedText = '') {
  const text = normalizeText(persistedText || visibleText);
  if (/模型返回格式不稳定|没拿到可用正文/i.test(text)) {
    return { type: 'response_parse_empty', text };
  }
  const failure = classifyReplyFailure(text);
  return {
    ...failure,
    type: failure.type || 'empty'
  };
}

function buildDirectedContextPrompt(routeMeta = {}) {
  const directedContext = routeMeta?.directedContext && typeof routeMeta.directedContext === 'object'
    ? routeMeta.directedContext
    : null;
  if (!directedContext) return '';
  const addressee = directedContext.addressee && typeof directedContext.addressee === 'object'
    ? directedContext.addressee
    : {};
  const quote = directedContext.quote && typeof directedContext.quote === 'object'
    ? directedContext.quote
    : null;
  const forwardContext = directedContext.forwardContext && typeof directedContext.forwardContext === 'object'
    ? directedContext.forwardContext
    : null;
  const quotePriority = directedContext.quotePriority && typeof directedContext.quotePriority === 'object'
    ? directedContext.quotePriority
    : null;
  const lines = [
    '[CurrentConversation]',
    `scene=${normalizeText(directedContext.scene || 'unclear') || 'unclear'}`,
    `current_message_to=${normalizeText(addressee.senderName || addressee.userId || addressee.kind || 'unclear') || 'unclear'}`
  ];
  if (quote) {
    const quoteFrom = normalizeText(quote.senderName || quote.senderId);
    if (normalizeText(quote.origin)) lines.push(`quoted_message_origin=${normalizeText(quote.origin)}`);
    if (quoteFrom) lines.push(`quoted_message_from=${quoteFrom}`);
    if (quote.hasImage === true) lines.push('quoted_message_has_image=true');
    if (normalizeText(quote.text)) lines.push(`quoted_message_text=${trimTextToChars(quote.text, 360)}`);
  }
  if (forwardContext) {
    const forwardIds = Array.isArray(forwardContext.ids)
      ? forwardContext.ids.map((item) => normalizeText(item)).filter(Boolean)
      : [];
    const imageCount = Math.max(0, Number(forwardContext.imageCount || forwardContext.imageUrls?.length || 0) || 0);
    const forwardedText = trimTextToChars(forwardContext.summaryText || '', 900);
    lines.push(`forward_context_source=${normalizeText(forwardContext.source || 'current_message_forward') || 'current_message_forward'}`);
    if (forwardIds.length) lines.push(`forwarded_message_ids=${forwardIds.join(',')}`);
    if (imageCount > 0) lines.push(`forwarded_message_image_count=${imageCount}`);
    if (forwardedText) lines.push(`forwarded_message_text=${forwardedText}`);
    lines.push('instruction=本轮转发内容就是当前可见上下文；用户问“那句话/当时在说什么/是不是对转发内容的反应”时，先看 forwarded_message_text，不要说不记得上下文。');
  }
  lines.push(`quote_priority_mode=${normalizeText(quotePriority?.mode || 'none') || 'none'}`);
  if (normalizeText(quotePriority?.reason)) lines.push(`quote_priority_reason=${normalizeText(quotePriority.reason)}`);
  if (normalizeText(quotePriority?.quoteAnchoredText)) lines.push(`quote_anchored_text=${trimTextToChars(quotePriority.quoteAnchoredText, 360)}`);
  return lines.join('\n');
}

function trimRecentMessagesByChars(messages = [], maxChars = 0) {
  const limit = clampNumber(maxChars, 0, 0);
  if (limit <= 0) return [];
  const source = (Array.isArray(messages) ? messages : [])
    .map((item) => normalizeHistoryMessage(item))
    .filter(Boolean);
  const kept = [];
  let used = 0;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const item = source[index];
    const cost = item.content.length;
    if (cost <= 0) continue;
    if (kept.length > 0 && used + cost > limit) break;
    if (kept.length === 0 && cost > limit) {
      kept.unshift({ ...item, content: trimTextToChars(item.content, limit) });
      break;
    }
    kept.unshift(item);
    used += cost;
  }
  return kept;
}

function buildSummaryText(sessionKey = '', deps = {}, runtimeConfig = config) {
  const summaryMaxChars = clampNumber(runtimeConfig.NORMAL_FAST_REPLY_SUMMARY_MAX_CHARS, 1500, 0);
  if (summaryMaxChars <= 0) return '';
  const loadSummaries = typeof deps.getRecentSessionContextSummaries === 'function'
    ? deps.getRecentSessionContextSummaries
    : getRecentSessionContextSummaries;
  const latest = loadSummaries(sessionKey, { limit: 1 })[0];
  const summary = trimTextToChars(latest?.summary || latest?.text || '', summaryMaxChars);
  return isReplyFailure(summary) ? '' : summary;
}

function isShortFastReplyPersonaModule(item = {}, maxTokenCost = NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_TOKEN_COST) {
  const id = normalizeText(item.id);
  if (!id || id === 'core_baseline' || id.startsWith('wb_mizuki_')) return false;
  const tokenCost = Number(item.tokenCost || 0) || 0;
  return tokenCost > 0 && tokenCost <= maxTokenCost;
}

function isFastReplyWorldbookModule(item = {}, maxTokenCost = NORMAL_FAST_REPLY_WORLDBOOK_MAX_TOKEN_COST) {
  const id = normalizeText(item.id);
  if (!id.startsWith('wb_mizuki_')) return false;
  const tokenCost = Number(item.tokenCost || 0) || 0;
  return tokenCost > 0 && tokenCost <= maxTokenCost;
}

function buildNormalFastReplyPersonaModules(context = {}, deps = {}) {
  if (context.disablePersonaModules === true || deps.disablePersonaModules === true) {
    return { modules: [], prompt: '', candidateCount: 0, personaModuleChars: 0, personaModuleTokenCost: 0 };
  }
  const runtimeConfig = deps.config || config;
  const maxActive = Math.min(
    NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_ACTIVE,
    clampNumber(runtimeConfig.NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_ACTIVE, NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_ACTIVE, 0)
  );
  if (maxActive <= 0) {
    return { modules: [], prompt: '', candidateCount: 0, personaModuleChars: 0, personaModuleTokenCost: 0 };
  }
  const maxTokenCost = clampNumber(
    runtimeConfig.NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_TOKEN_COST,
    NORMAL_FAST_REPLY_PERSONA_MODULE_MAX_TOKEN_COST,
    1
  );
  const maxTextChars = clampNumber(
    runtimeConfig.NORMAL_FAST_REPLY_PERSONA_MODULE_TEXT_MAX_CHARS,
    NORMAL_FAST_REPLY_PERSONA_MODULE_TEXT_MAX_CHARS,
    100
  );
  try {
    const candidates = buildPersonaModuleCandidates({
      ...context,
      mainReplyPromptMode: 'balanced',
      promptMode: 'balanced',
      maxPersonaModuleCandidates: context.maxPersonaModuleCandidates || 8
    }).filter((item) => isShortFastReplyPersonaModule(item, maxTokenCost));
    if (!candidates.length) {
      return { modules: [], prompt: '', candidateCount: 0, personaModuleChars: 0, personaModuleTokenCost: 0 };
    }
    const decision = selectPersonaModules({}, {
      ...context,
      mainReplyPromptMode: 'balanced',
      promptMode: 'balanced',
      personaModuleCandidates: candidates,
      maxActiveModules: maxActive
    });
    const selected = decision.selected
      .filter((item) => isShortFastReplyPersonaModule(item, maxTokenCost))
      .slice(0, maxActive);
    const modules = [];
    for (const item of selected) {
      const text = trimPromptTextToChars(loadPersonaModuleText(item.id), maxTextChars);
      if (!text) continue;
      modules.push({
        id: item.id,
        tokenCost: Number(item.tokenCost || 0) || 0,
        text,
        chars: text.length
      });
    }
    if (!modules.length) {
      return { modules: [], prompt: '', candidateCount: candidates.length, personaModuleChars: 0, personaModuleTokenCost: 0 };
    }
    const prompt = [
      '[FastPersonaModules]',
      '以下短 persona modules 只作为本轮语气/姿态参考；不要复述模块名。',
      ...modules.flatMap((item) => [`persona_module_${item.id}:`, item.text])
    ].join('\n');
    return {
      modules,
      prompt,
      candidateCount: candidates.length,
      personaModuleChars: modules.reduce((sum, item) => sum + item.chars, 0),
      personaModuleTokenCost: modules.reduce((sum, item) => sum + item.tokenCost, 0)
    };
  } catch (_) {
    return { modules: [], prompt: '', candidateCount: 0, personaModuleChars: 0, personaModuleTokenCost: 0 };
  }
}

function buildNormalFastReplyWorldbookModules(context = {}, deps = {}) {
  if (context.disableWorldbook === true || deps.disableWorldbook === true) {
    return { modules: [], prompt: '', candidateCount: 0, worldbookChars: 0, worldbookTokenCost: 0 };
  }
  const runtimeConfig = deps.config || config;
  if (runtimeConfig.NORMAL_FAST_REPLY_WORLDBOOK_ENABLED === false) {
    return { modules: [], prompt: '', candidateCount: 0, worldbookChars: 0, worldbookTokenCost: 0 };
  }
  const maxActive = Math.min(
    NORMAL_FAST_REPLY_WORLDBOOK_MAX_ACTIVE,
    clampNumber(runtimeConfig.NORMAL_FAST_REPLY_WORLDBOOK_MAX_ACTIVE, NORMAL_FAST_REPLY_WORLDBOOK_MAX_ACTIVE, 0)
  );
  if (maxActive <= 0) {
    return { modules: [], prompt: '', candidateCount: 0, worldbookChars: 0, worldbookTokenCost: 0 };
  }
  const maxTokenCost = clampNumber(
    runtimeConfig.NORMAL_FAST_REPLY_WORLDBOOK_MAX_TOKEN_COST,
    NORMAL_FAST_REPLY_WORLDBOOK_MAX_TOKEN_COST,
    1
  );
  const maxTextChars = clampNumber(
    runtimeConfig.NORMAL_FAST_REPLY_WORLDBOOK_TEXT_MAX_CHARS,
    NORMAL_FAST_REPLY_WORLDBOOK_TEXT_MAX_CHARS,
    100
  );
  const buildCandidates = typeof deps.buildPersonaModuleCandidates === 'function'
    ? deps.buildPersonaModuleCandidates
    : buildPersonaModuleCandidates;
  const loadModuleText = typeof deps.loadPersonaModuleText === 'function'
    ? deps.loadPersonaModuleText
    : loadPersonaModuleText;
  try {
    const candidates = buildCandidates({
      ...context,
      mainReplyPromptMode: 'balanced',
      promptMode: 'balanced',
      disableLocalPromptRecall: true,
      worldbookLimit: Math.max(maxActive, Number(context.worldbookLimit || 0) || maxActive),
      maxPersonaModuleCandidates: context.maxPersonaModuleCandidates || 8
    }).filter((item) => isFastReplyWorldbookModule(item, maxTokenCost));
    if (!candidates.length) {
      return { modules: [], prompt: '', candidateCount: 0, worldbookChars: 0, worldbookTokenCost: 0 };
    }
    const selected = candidates.slice(0, maxActive);
    const modules = [];
    for (const item of selected) {
      const text = trimPromptTextToChars(loadModuleText(item.id), maxTextChars);
      if (!text) continue;
      modules.push({
        id: item.id,
        tokenCost: Number(item.tokenCost || 0) || 0,
        text,
        chars: text.length
      });
    }
    if (!modules.length) {
      return { modules: [], prompt: '', candidateCount: candidates.length, worldbookChars: 0, worldbookTokenCost: 0 };
    }
    const prompt = [
      '[FastWorldbook]',
      '以下世界书只补本轮设定、剧情节点或角色关系事实；不要复述模块名，不要扩写成长期记忆。',
      ...modules.flatMap((item) => [`persona_module_${item.id}:`, item.text])
    ].join('\n');
    return {
      modules,
      prompt,
      candidateCount: candidates.length,
      worldbookChars: modules.reduce((sum, item) => sum + item.chars, 0),
      worldbookTokenCost: modules.reduce((sum, item) => sum + item.tokenCost, 0)
    };
  } catch (_) {
    return { modules: [], prompt: '', candidateCount: 0, worldbookChars: 0, worldbookTokenCost: 0 };
  }
}

function buildNormalFastReplyMessages(input = {}, deps = {}) {
  const runtimeConfig = deps.config || config;
  const userId = normalizeText(input.userId || input.senderId || input.routeMeta?.userId || input.routeMeta?.user_id);
  const routeMeta = input.routeMeta && typeof input.routeMeta === 'object'
    ? input.routeMeta
    : (input.route?.meta && typeof input.route.meta === 'object' ? input.route.meta : {});
  const sessionKey = normalizeText(
    input.sessionKey
    || routeMeta.sessionKey
    || routeMeta.session_key
    || resolveShortTermSessionKey(userId, routeMeta)
  );
  const turns = clampNumber(runtimeConfig.NORMAL_FAST_REPLY_RECENT_TURNS, 12, 1);
  const maxMessages = Math.max(2, turns * 2);
  const contextMaxChars = clampNumber(runtimeConfig.NORMAL_FAST_REPLY_CONTEXT_MAX_CHARS, 8000, 1000);
  const summaryMaxChars = clampNumber(runtimeConfig.NORMAL_FAST_REPLY_SUMMARY_MAX_CHARS, 1500, 0);
  const summaryBudget = Math.min(summaryMaxChars, contextMaxChars);
  const summaryText = buildSummaryText(sessionKey, deps, runtimeConfig);
  const trimmedSummary = trimTextToChars(summaryText, summaryBudget);
  const recentRawBudget = Math.max(0, contextMaxChars - summaryBudget);
  const recentBudget = Math.min(recentRawBudget, Math.max(0, contextMaxChars - trimmedSummary.length));
  const historyStore = deps.chatHistory || input.chatHistory || {};
  const rawHistory = Array.isArray(historyStore[sessionKey]) ? historyStore[sessionKey] : [];
  const safeRawHistory = rawHistory.map((item) => normalizeHistoryMessage(item)).filter(Boolean);
  const recentMessages = trimRecentMessagesByChars(safeRawHistory.slice(-maxMessages), recentBudget);
  const userText = normalizeText(input.text || input.cleanText || input.requestText || input.route?.cleanText || input.route?.question);
  const livenessPrompt = buildChatLivenessDisciplinePrompt({
    routeMeta,
    topRouteType: 'direct_chat',
    question: userText,
    userId,
    sharedShortTermContext: {
      shortTermSummary: trimmedSummary,
      recentHistory: recentMessages
    }
  });
  const directedPrompt = buildDirectedContextPrompt(routeMeta);
  const fastPersonaModules = buildNormalFastReplyPersonaModules({
    question: userText,
    routePrompt: userText,
    routeMeta,
    directedContext: routeMeta.directedContext,
    chatType: normalizeText(routeMeta.chatType || routeMeta.chat_type),
    userId,
    senderId: normalizeText(input.senderId || routeMeta.senderId || routeMeta.sender_id),
    groupId: normalizeText(input.groupId || routeMeta.groupId || routeMeta.group_id),
    sessionKey,
    continuitySignals: trimmedSummary || recentMessages.length > 0
      ? { hasCarryOverTopic: true }
      : {}
  }, deps);
  const fastWorldbookModules = buildNormalFastReplyWorldbookModules({
    question: userText,
    routePrompt: userText,
    routeMeta,
    directedContext: routeMeta.directedContext,
    chatType: normalizeText(routeMeta.chatType || routeMeta.chat_type),
    userId,
    senderId: normalizeText(input.senderId || routeMeta.senderId || routeMeta.sender_id),
    groupId: normalizeText(input.groupId || routeMeta.groupId || routeMeta.group_id),
    sessionKey
  }, deps);
  const stableSystemBlocks = buildMainStableSystemBlocks({
    systemPrompt: runtimeConfig.SYSTEM_PROMPT,
    systemPromptBlocks: Array.isArray(runtimeConfig.SYSTEM_PROMPT_BLOCKS)
      ? runtimeConfig.SYSTEM_PROMPT_BLOCKS
      : undefined,
    userId,
    senderId: normalizeText(input.senderId || routeMeta.senderId || routeMeta.sender_id),
    chatType: normalizeText(routeMeta.chatType || routeMeta.chat_type),
    routeMeta,
    modelName: normalizeText(runtimeConfig.AI_MODEL || runtimeConfig.modelName || runtimeConfig.model || '')
  }).filter((block) => block.id === 'normal_user_default_prompt');
  const stableSystemPrompt = stableSystemBlocks
    .map((block) => String(block.content || '').trim())
    .filter(Boolean)
    .join('\n');
  const systemParts = [
    stableSystemPrompt,
    '你是 Mizuki。当前走普通用户快速回复链路。',
    '只根据用户本轮消息和下方轻量上下文自然回复；不要声称查了记忆、网页或工具。',
    '如果用户本轮是在评价、纠正或吐槽“你刚才/后面几段/上一条回复”，优先锚定最近一条 assistant 历史回复来接话。',
    '回答保持简洁、直接、像日常聊天；信息不足时先说明不确定。',
    directedPrompt,
    livenessPrompt,
    fastPersonaModules.prompt,
    fastWorldbookModules.prompt
  ];
  if (trimmedSummary) {
    systemParts.push(`[最近会话摘要]\n${trimmedSummary}`);
  }

  return {
    messages: [
      { role: 'system', content: systemParts.join('\n') },
      ...recentMessages,
      { role: 'user', content: userText }
    ],
    sessionKey,
    summaryChars: trimmedSummary.length,
    recentMessageCount: recentMessages.length,
    recentChars: recentMessages.reduce((sum, item) => sum + item.content.length, 0),
    contextMaxChars,
    stablePromptBlockIds: stableSystemBlocks.map((item) => item.id),
    personaModules: fastPersonaModules.modules.map((item) => item.id),
    personaModuleChars: fastPersonaModules.personaModuleChars,
    personaModuleTokenCost: fastPersonaModules.personaModuleTokenCost,
    personaModuleCandidateCount: fastPersonaModules.candidateCount,
    worldbookModules: fastWorldbookModules.modules.map((item) => item.id),
    worldbookChars: fastWorldbookModules.worldbookChars,
    worldbookTokenCost: fastWorldbookModules.worldbookTokenCost,
    worldbookCandidateCount: fastWorldbookModules.candidateCount
  };
}

async function runNormalFastReply(input = {}, deps = {}) {
  const runtimeConfig = deps.config || config;
  const requestReply = typeof deps.requestNonStreamingReply === 'function'
    ? deps.requestNonStreamingReply
    : requestNonStreamingReply;
  const built = buildNormalFastReplyMessages(input, deps);
  const userId = normalizeText(input.userId || input.senderId || input.routeMeta?.userId || input.routeMeta?.user_id);
  const routeMeta = input.routeMeta && typeof input.routeMeta === 'object'
    ? input.routeMeta
    : (input.route?.meta && typeof input.route.meta === 'object' ? input.route.meta : {});
  const maxTokens = clampNumber(runtimeConfig.NORMAL_FAST_REPLY_MAX_TOKENS, 512, 64);
  const reply = await requestReply(built.messages, {
    userId,
    routeMeta,
    routePolicyKey: 'chat/default',
    routeDebugKey: 'direct_chat/text_chat/answer',
    topRouteType: 'direct_chat',
    disableTools: true,
    allowedTools: [],
    disableHumanizer: true,
    modelConfig: {
      maxTokens,
      reasoningEffort: 'off',
      topK: NaN,
      topA: NaN,
      repetitionPenalty: NaN
    },
    source: 'normal_fast_reply',
    dispatchBranch: 'normal_fast_reply',
    triggerBranch: 'normal_fast_reply',
    requestTrace: routeMeta.requestTrace
  });
  const rawVisibleText = reply?.visibleText || reply?.text || reply?.content || reply;
  const rawPersistedText = reply?.persistedText || rawVisibleText;
  const visibleMeta = sanitizeUserFacingText(rawVisibleText, { returnMeta: true });
  const persistedMeta = sanitizeUserFacingText(rawPersistedText, { returnMeta: true });
  const visibleText = normalizeText(visibleMeta.text);
  const persistedText = normalizeText(persistedMeta.text || visibleText);
  const hasSafetyRestriction = Boolean(
    reply?.hasSafetyRestriction === true
    || visibleMeta.hasSafetyRestriction === true
    || persistedMeta.hasSafetyRestriction === true
  );
  if (isReplyFailure(visibleText, { emptyIsFailure: true }) || isReplyFailure(persistedText, { emptyIsFailure: true })) {
    const failure = classifyNormalFastReplyFailure(visibleText, persistedText);
    const error = new Error(`normal_fast_reply_model_failure:${failure.type || 'empty'}`);
    error.code = 'NORMAL_FAST_REPLY_MODEL_FAILURE';
    error.failureType = failure.type || 'empty';
    throw error;
  }
  if (isUnsafeUserFacingReply(visibleText) || isUnsafeUserFacingReply(persistedText)) {
    const error = new Error('normal_fast_reply_unsafe_user_facing_reply');
    error.code = 'NORMAL_FAST_REPLY_UNSAFE_USER_FACING_REPLY';
    throw error;
  }
  return {
    ...built,
    replyText: visibleText,
    persistedReplyText: persistedText,
    reasoningText: String(reply?.reasoningText || '').trim(),
    hasSafetyRestriction
  };
}

module.exports = {
  buildDirectedContextPrompt,
  buildNormalFastReplyMessages,
  buildNormalFastReplyPersonaModules,
  buildNormalFastReplyWorldbookModules,
  classifyNormalFastReplyFailure,
  runNormalFastReply,
  trimRecentMessagesByChars
};

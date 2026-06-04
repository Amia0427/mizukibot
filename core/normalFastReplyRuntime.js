const config = require('../config');
const { requestNonStreamingReply } = require('../api/runtimeV2/model/service');
const { getRecentSessionContextSummaries } = require('../utils/sessionContextSummaryStore');
const { resolveShortTermSessionKey } = require('../utils/shortTermMemory');
const { buildChatLivenessDisciplinePrompt } = require('../utils/chatLivenessContext');
const { isUnsafeUserFacingReply } = require('../utils/userFacingReplyGuards');

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
  if (normalizedRole === 'assistant' && isUnsafeUserFacingReply(content)) return null;
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
  return trimTextToChars(latest?.summary || latest?.text || '', summaryMaxChars);
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
  const systemParts = [
    '你是 Mizuki。当前走普通用户快速回复链路。',
    '只根据用户本轮消息和下方轻量上下文自然回复；不要声称查了记忆、网页或工具。',
    '如果用户本轮是在评价、纠正或吐槽“你刚才/后面几段/上一条回复”，优先锚定最近一条 assistant 历史回复来接话。',
    '回答保持简洁、直接、像日常聊天；信息不足时先说明不确定。',
    livenessPrompt
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
    contextMaxChars
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
      maxTokens
    },
    source: 'normal_fast_reply',
    dispatchBranch: 'normal_fast_reply',
    triggerBranch: 'normal_fast_reply',
    requestTrace: routeMeta.requestTrace
  });
  const visibleText = normalizeText(reply?.visibleText || reply?.text || reply?.content || reply);
  const persistedText = normalizeText(reply?.persistedText || visibleText);
  return {
    ...built,
    replyText: visibleText,
    persistedReplyText: persistedText
  };
}

module.exports = {
  buildNormalFastReplyMessages,
  runNormalFastReply,
  trimRecentMessagesByChars
};

const config = require('../../config');
const { getAffinitySettings } = require('../contextBudget');

const MEMORY_RECALL_QUERY_RE = /(昨天|昨日|前天|大前天|今天|今日|刚才|刚刚|上次|之前|前面|前几天|那天|聊了什么|聊过什么|聊到哪|说了什么|讲了什么|还记得|记得|记不记得|回忆|想起来|接着|继续|继续.*刚才|接着.*刚才|你刚|你说过|引用.*继续|断片|失忆|\byesterday\b|\bremember\b|\blast time\b|\bearlier\b|what did we talk|where did we leave)/i;

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function readPositiveInt(key, fallback, min = 1) {
  return Math.max(min, Math.floor(Number(config[key] || fallback) || fallback));
}

function readPositiveNumber(key, fallback, min = 0.05) {
  return Math.max(min, Number(config[key] || fallback) || fallback);
}

function getRouteText(options = {}) {
  const routeMeta = options.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  return normalizeText([
    options.question,
    options.cleanText,
    options.rawText,
    routeMeta.cleanText,
    routeMeta.rawText,
    routeMeta.userText,
    routeMeta.question
  ].filter(Boolean).join('\n'));
}

function hasGroupOrChannel(routeMeta = {}) {
  return Boolean(
    normalizeText(routeMeta.groupId || routeMeta.group_id)
    || normalizeText(routeMeta.channelId || routeMeta.channel_id)
  );
}

function isLongTaskRoute(options = {}) {
  const routeMeta = options.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const routePolicyKey = normalizeText(options.routePolicyKey || routeMeta.routePolicyKey || routeMeta.policyKey).toLowerCase();
  const topRouteType = normalizeText(options.topRouteType || routeMeta.topRouteType).toLowerCase();
  const taskType = normalizeText(routeMeta.taskType || routeMeta.task_type || options.taskType).toLowerCase();
  const text = getRouteText(options);
  if (/^(plan|act|tool|research|code|deploy|admin)\//i.test(routePolicyKey)) return true;
  if (['plan', 'act', 'tool', 'research', 'subagent', 'admin_task'].includes(topRouteType)) return true;
  if (taskType && !['chat', 'direct_chat', 'smalltalk'].includes(taskType)) return true;
  return text.length >= 420 || /(实现|修复|重构|部署|迁移|排查|诊断|测试|提交|commit|deploy|refactor|implement|debug|continue the task)/i.test(text);
}

function resolveShortTermContextProfile(userInfo = {}, options = {}) {
  const routeMeta = options.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const userId = normalizeText(options.userId);
  const affinity = getAffinitySettings(userInfo, {
    userId,
    chatType: routeMeta.chatType || routeMeta.chat_type
  });
  const routeText = getRouteText(options);
  const adminPrivate = affinity.highAffinity && !hasGroupOrChannel(routeMeta);
  const memoryRecall = options.forceMemoryContext === true
    || options.intent?.needsMemory === true
    || routeMeta.intent?.needsMemory === true
    || MEMORY_RECALL_QUERY_RE.test(routeText);
  const longTask = isLongTaskRoute(options);

  if (adminPrivate) {
    return {
      name: 'admin_private_chat',
      reason: 'admin_private_chat',
      recentRawMessageLimit: readPositiveInt('MAIN_REPLY_CONTEXT_ADMIN_PRIVATE_RECENT_RAW_MESSAGES', 240),
      recentRawNewestMin: readPositiveInt('MAIN_REPLY_CONTEXT_ADMIN_PRIVATE_NEWEST_RAW_MESSAGES', 24),
      rawTokenMultiplier: readPositiveNumber('MAIN_REPLY_CONTEXT_ADMIN_PRIVATE_TOKEN_MULTIPLIER', 1.4),
      summaryLoadCount: readPositiveInt('MAIN_REPLY_CONTEXT_ADMIN_PRIVATE_SUMMARY_LOAD_COUNT', 10),
      affinity
    };
  }

  if (memoryRecall) {
    return {
      name: 'memory_recall',
      reason: 'memory_recall_query',
      recentRawMessageLimit: readPositiveInt('MAIN_REPLY_CONTEXT_MEMORY_RECALL_RECENT_RAW_MESSAGES', 180),
      recentRawNewestMin: readPositiveInt('MAIN_REPLY_CONTEXT_MEMORY_RECALL_NEWEST_RAW_MESSAGES', 18),
      rawTokenMultiplier: readPositiveNumber('MAIN_REPLY_CONTEXT_MEMORY_RECALL_TOKEN_MULTIPLIER', 1.15),
      summaryLoadCount: readPositiveInt('MAIN_REPLY_CONTEXT_MEMORY_RECALL_SUMMARY_LOAD_COUNT', 8),
      affinity
    };
  }

  if (longTask) {
    return {
      name: 'long_task',
      reason: 'long_task_route',
      recentRawMessageLimit: readPositiveInt('MAIN_REPLY_CONTEXT_LONG_TASK_RECENT_RAW_MESSAGES', 160),
      recentRawNewestMin: readPositiveInt('MAIN_REPLY_CONTEXT_LONG_TASK_NEWEST_RAW_MESSAGES', 16),
      rawTokenMultiplier: readPositiveNumber('MAIN_REPLY_CONTEXT_LONG_TASK_TOKEN_MULTIPLIER', 1),
      summaryLoadCount: readPositiveInt('MAIN_REPLY_CONTEXT_LONG_TASK_SUMMARY_LOAD_COUNT', 7),
      affinity
    };
  }

  return {
    name: 'normal_chat',
    reason: 'default',
    recentRawMessageLimit: readPositiveInt('MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES', 96),
    recentRawNewestMin: readPositiveInt('MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES', 12),
    rawTokenMultiplier: readPositiveNumber('MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER', 0.75),
    summaryLoadCount: readPositiveInt('MAIN_REPLY_CONTEXT_NORMAL_SUMMARY_LOAD_COUNT', config.SESSION_CONTEXT_SUMMARY_LOAD_COUNT || 5),
    affinity
  };
}

function applyContextProfileToTokenBudget(baseTokens = 0, profile = {}) {
  const budget = Math.max(0, Number(baseTokens || 0) || 0);
  const multiplier = Math.max(0.05, Number(profile.rawTokenMultiplier || 1) || 1);
  return Math.max(0, Math.floor(budget * multiplier));
}

module.exports = {
  MEMORY_RECALL_QUERY_RE,
  applyContextProfileToTokenBudget,
  resolveShortTermContextProfile
};

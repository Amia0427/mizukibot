const config = require('../config');
const { isPrivilegedPrivateChatUser } = require('./privilegedPrivateChat');

function getAdminUserIds() {
  return new Set((config.ADMIN_USER_IDS || []).map((id) => String(id).trim()).filter(Boolean));
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      if (part && typeof part.content === 'string') return part.content;
      return '';
    }).join(' ');
  }
  if (content && typeof content.text === 'string') return content.text;
  return String(content || '');
}

function estimateTokens(value) {
  const text = normalizeText(value);
  if (!text) return 0;

  let cjkChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3400 && code <= 0x9fff) cjkChars += 1;
  }

  const latinChars = text.length - cjkChars;
  return cjkChars + Math.ceil(Math.max(0, latinChars) / 4);
}

function estimateMessageTokens(message) {
  if (!message) return 0;
  const roleCost = 6;
  return roleCost + estimateTokens(normalizeMessageContent(message.content));
}

function estimateMessagesTokens(messages = []) {
  return (Array.isArray(messages) ? messages : []).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function getAffinityPoints(userInfo = {}) {
  const points = Number(userInfo && userInfo.points);
  return Number.isFinite(points) ? points : 0;
}

function isHighAffinityUser(userInfo = {}, options = {}) {
  const userId = String(options && options.userId || '').trim();
  if (Boolean(userId) && getAdminUserIds().has(userId)) return true;
  return isPrivilegedPrivateChatUser({
    chatType: options?.chatType,
    userId,
    config
  });
}

function getAffinitySettings(userInfo = {}, options = {}) {
  const highAffinity = isHighAffinityUser(userInfo, options);
  return {
    points: getAffinityPoints(userInfo),
    highAffinity,
    budgetTier: highAffinity ? 'admin' : 'normal',
    isAdminBudget: highAffinity,
    contextWindowTokens: highAffinity
      ? Math.max(4000, Number(config.ADMIN_CONTEXT_WINDOW_MAX_TOKENS || config.HIGH_AFFINITY_CONTEXT_WINDOW_MAX_TOKENS || 258000))
      : Math.max(2000, Number(config.CONTEXT_WINDOW_MAX_TOKENS || 32000)),
    shortTermMemoryTokens: highAffinity
      ? Math.max(4000, Number(config.ADMIN_SHORT_TERM_MEMORY_MAX_TOKENS || config.HIGH_AFFINITY_SHORT_TERM_MEMORY_MAX_TOKENS || 400000))
      : Math.max(1000, Number(config.SHORT_TERM_MEMORY_MAX_TOKENS || 12000))
  };
}

function trimTextByTokenBudget(text, tokenBudget, strategy = 'tail') {
  const input = String(text || '');
  const budget = Math.max(0, Number(tokenBudget) || 0);
  if (!input || budget <= 0) return '';
  if (estimateTokens(input) <= budget) return input;

  if (strategy === 'head') {
    let end = input.length;
    while (end > 0 && estimateTokens(input.slice(0, end)) > budget) end -= 32;
    return input.slice(0, Math.max(end, 0)).trim();
  }

  let start = 0;
  while (start < input.length && estimateTokens(input.slice(start)) > budget) start += 32;
  return input.slice(Math.min(start, input.length)).trim();
}

function trimMessagesByTokenBudget(messages = [], tokenBudget = 0) {
  const list = Array.isArray(messages) ? messages : [];
  const budget = Math.max(0, Number(tokenBudget) || 0);
  if (!list.length || budget <= 0) return [];

  const kept = [];
  let used = 0;

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    const cost = estimateMessageTokens(message);
    if (kept.length > 0 && used + cost > budget) break;
    if (kept.length === 0 && cost > budget) {
      kept.unshift({
        ...message,
        content: trimTextByTokenBudget(normalizeMessageContent(message.content), Math.max(64, budget - 6), 'tail')
      });
      break;
    }

    kept.unshift(message);
    used += cost;
  }

  return kept;
}

module.exports = {
  normalizeMessageContent,
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  getAffinityPoints,
  isHighAffinityUser,
  getAffinitySettings,
  trimTextByTokenBudget,
  trimMessagesByTokenBudget
};

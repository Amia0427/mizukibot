const { classifyMemoryNeed } = require('../recallHeuristics');
const { isUnsafeUserFacingReply } = require('../userFacingReplyGuards');
const { recallPollutionReason } = require('../recallPollutionGuard');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const UNSAFE_ASSISTANT_RE = /(?:你是谁来着|你是谁啊|我不知道你是谁|不知道你是谁|我不记得你|不记得你|我记不得你|记不得你|我不认识你|不认识你|没有相关记忆|没有查到相关记忆|没有找到相关记忆|想不起来你是谁|想不起你是谁|忘了你是谁)/i;
const IDENTITY_OR_RELATIONSHIP_USER_RE = /(?:我是谁|你认识我吗|你认得我吗|你知道我是谁吗|知道我是谁吗|还记得我吗|还记得我是谁吗|忘了我|不记得我|不认识我|我们的往日种种|我们的过去|我们之间|我和你的关系|咱们之间)/i;

function isIdentityOrRelationshipRecall(question = '') {
  const text = normalizeText(question);
  if (!text) return false;
  if (IDENTITY_OR_RELATIONSHIP_USER_RE.test(text)) return true;
  const need = classifyMemoryNeed(text);
  return need.needsMemory && (need.facet === 'identity' || need.facet === 'relationship' || need.facet === 'broad_recall');
}

function classifyJournalEntrySafety(entry = {}, options = {}) {
  const userText = normalizeText(entry.user || entry.question || options.question || '');
  const assistantText = normalizeText(entry.assistant || entry.reply || options.reply || '');
  if (!assistantText) return { safe: false, reason: 'empty_assistant' };
  if (UNSAFE_ASSISTANT_RE.test(assistantText)) {
    if (isIdentityOrRelationshipRecall(userText)) {
      return { safe: false, reason: 'unsafe_identity_recall_reply' };
    }
    return { safe: false, reason: 'unsafe_memory_failure_reply' };
  }
  if (isUnsafeUserFacingReply(assistantText)) return { safe: false, reason: 'unsafe_user_facing_reply' };
  const pollutionReason = recallPollutionReason(assistantText, { allowBenignContext: false });
  if (pollutionReason) return { safe: false, reason: pollutionReason };
  return { safe: true, reason: '' };
}

function isJournalEntryInjectable(entry = {}, options = {}) {
  return classifyJournalEntrySafety(entry, options).safe;
}

function filterInjectableJournalEntries(entries = [], options = {}) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => isJournalEntryInjectable(entry, options));
}

module.exports = {
  classifyJournalEntrySafety,
  filterInjectableJournalEntries,
  isIdentityOrRelationshipRecall,
  isJournalEntryInjectable,
  normalizeText
};

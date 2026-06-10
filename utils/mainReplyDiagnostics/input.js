const config = require('../../config');
const { resolveShortTermSessionKey } = require('../shortTermMemory');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseMaybeJsonObject(text = '') {
  const raw = normalizeText(text);
  if (!raw || !raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function parseMainReplyDiagnosticInput(input = '') {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { ...input };
  }
  const raw = normalizeText(input);
  const parsed = parseMaybeJsonObject(raw);
  if (parsed) return parsed;
  return {
    rawText: raw,
    cleanText: raw,
    requestText: raw
  };
}

function resolveRequestText(input = {}) {
  return normalizeText(
    input.requestText
    || input.cleanText
    || input.text
    || input.rawText
    || input.question
    || input.message
  );
}

function normalizeDiagnosticContext(input = {}) {
  const source = normalizeObject(input);
  const rawText = normalizeText(source.rawText || source.message || source.text || source.requestText);
  const cleanText = normalizeText(source.cleanText || source.requestText || source.question || rawText);
  const userId = normalizeText(source.userId || source.senderId || source.user_id);
  const groupId = normalizeText(source.groupId || source.group_id);
  const chatType = normalizeText(source.chatType || source.messageType || source.message_type || (groupId ? 'group' : 'private')).toLowerCase() === 'private'
    ? 'private'
    : 'group';
  const sessionKey = normalizeText(source.sessionKey || source.session_key)
    || resolveShortTermSessionKey(userId, { groupId, chatType });
  const botQQ = normalizeText(source.botQQ || source.botQq || source.selfId || config.BOT_QQ);
  const imageUrls = normalizeArray(source.imageUrls)
    .concat(source.imageUrl ? [source.imageUrl] : [])
    .map((url) => normalizeText(url))
    .filter(Boolean);
  return {
    rawText: rawText || cleanText,
    cleanText,
    requestText: resolveRequestText(source) || cleanText || rawText,
    userId,
    groupId,
    chatType,
    sessionKey,
    botQQ,
    imageUrl: imageUrls[0] || null,
    imageUrls,
    contextSummary: normalizeText(source.contextSummary || source.conversationSummary),
    directedContext: normalizeObject(source.directedContext, null),
    candidateReply: normalizeText(source.candidateReply || source.replyText || source.finalReply || source.outputText)
  };
}

module.exports = {
  normalizeArray,
  normalizeDiagnosticContext,
  normalizeObject,
  normalizeText,
  parseMainReplyDiagnosticInput,
  parseMaybeJsonObject,
  resolveRequestText
};

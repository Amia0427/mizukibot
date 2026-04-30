const GROUP_DIRECT_REPLY_TARGET_MIN_CHARS = 80;
const GROUP_DIRECT_REPLY_TARGET_MAX_CHARS = 180;
const GROUP_DIRECT_REPLY_CHAR_LIMIT = 220;
const GROUP_DIRECT_REPLY_MAX_SENTENCES = 3;
const GROUP_DIRECT_REPLY_MAX_QUESTION_SENTENCES = 1;

const GROUP_DIRECT_TEACHING_PATTERNS = [
  /最先要记(?:的)?/,
  /然后/,
  /还有一个坑/,
  /推荐的入门路子/,
  /推荐路线/,
  /入门路线/,
  /学习路线/,
  /怎么入门/,
  /如何学习/,
  /先搞定/,
  /首先/,
  /其次/,
  /最后/,
  /第一[，,、:：]/,
  /第二[，,、:：]/,
  /步骤/,
  /教程/,
  /提纲/,
  /总结/,
  /核心逻辑/,
  /你需要先/,
  /建议你先/
];

function getRouteMetaGroupId(routeMeta = {}) {
  const normalizedRouteMeta = routeMeta && typeof routeMeta === 'object' ? routeMeta : {};
  return String(normalizedRouteMeta.groupId || normalizedRouteMeta.group_id || '').trim();
}

function isGroupDirectChatRequest(request = {}) {
  const normalizedRequest = request && typeof request === 'object' ? request : {};
  const routeMeta = normalizedRequest.routeMeta && typeof normalizedRequest.routeMeta === 'object'
    ? normalizedRequest.routeMeta
    : {};
  const topRouteType = String(normalizedRequest.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  return topRouteType === 'direct_chat' && Boolean(getRouteMetaGroupId(routeMeta));
}

function splitChineseSentences(text = '') {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return [];
  const sentences = compact.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [compact];
  return sentences.map((item) => item.trim()).filter(Boolean);
}

function countQuestionMarks(text = '') {
  return (String(text || '').match(/[？?]/g) || []).length;
}

function isQuestionSentence(sentence = '') {
  return /[？?]/.test(String(sentence || ''));
}

function buildGroupDirectStyleGuardReasons(original = '') {
  const text = String(original || '').trim();
  const reasons = [];
  if (text.length > GROUP_DIRECT_REPLY_CHAR_LIMIT) reasons.push('too_long');
  for (const pattern of GROUP_DIRECT_TEACHING_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push('teaching_structure');
      break;
    }
  }
  const questionSentenceCount = splitChineseSentences(text).filter(isQuestionSentence).length;
  if (
    countQuestionMarks(text) > GROUP_DIRECT_REPLY_MAX_QUESTION_SENTENCES
    || questionSentenceCount > GROUP_DIRECT_REPLY_MAX_QUESTION_SENTENCES
  ) {
    reasons.push('too_many_questions');
  }
  return reasons;
}

function trimSentencesToGroupDirectBudget(sentences = [], limit = GROUP_DIRECT_REPLY_CHAR_LIMIT) {
  const kept = [];
  let current = '';
  for (const sentence of sentences) {
    if (kept.length >= GROUP_DIRECT_REPLY_MAX_SENTENCES) break;
    const next = `${current}${sentence}`;
    if (next.length > limit) break;
    kept.push(sentence);
    current = next;
  }
  return kept.join('').trim();
}

function reduceQuestionSentences(sentences = []) {
  let keptQuestions = 0;
  const reduced = [];
  for (const sentence of sentences) {
    if (!isQuestionSentence(sentence)) {
      reduced.push(sentence);
      continue;
    }
    keptQuestions += 1;
    if (keptQuestions <= GROUP_DIRECT_REPLY_MAX_QUESTION_SENTENCES) {
      reduced.push(sentence);
    }
  }
  return reduced.length > 0 ? reduced : sentences.slice(0, 1);
}

function trimGroupDirectReplyText(text = '', limit = GROUP_DIRECT_REPLY_CHAR_LIMIT, reasons = []) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';

  const normalizedLimit = Math.max(60, Number(limit) || GROUP_DIRECT_REPLY_CHAR_LIMIT);
  const reasonSet = new Set(Array.isArray(reasons) ? reasons : []);
  let sentences = splitChineseSentences(compact);

  if (reasonSet.has('too_many_questions')) {
    sentences = reduceQuestionSentences(sentences);
  }

  const sentenceTrimmed = trimSentencesToGroupDirectBudget(sentences, normalizedLimit);
  if (sentenceTrimmed) return sentenceTrimmed;
  return compact.slice(0, normalizedLimit).trim();
}

function applyGroupDirectStyleGuard(reply = '', request = {}) {
  const original = String(reply || '').trim();
  if (!original || !isGroupDirectChatRequest(request)) {
    return {
      text: original,
      applied: false,
      reasons: [],
      originalChars: original.length,
      finalChars: original.length
    };
  }

  const reasons = buildGroupDirectStyleGuardReasons(original);
  if (reasons.length === 0) {
    return {
      text: original,
      applied: false,
      reasons,
      originalChars: original.length,
      finalChars: original.length
    };
  }

  const text = trimGroupDirectReplyText(original, GROUP_DIRECT_REPLY_CHAR_LIMIT, reasons);
  return {
    text,
    applied: text !== original || reasons.length > 0,
    reasons,
    originalChars: original.length,
    finalChars: text.length
  };
}

function createGroupDirectStyleGuardEvent(createEvent, node, guard = {}) {
  const makeEvent = typeof createEvent === 'function'
    ? createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  return makeEvent('group_direct_style_guard', {
    node,
    groupDirectStyleGuardApplied: true,
    originalChars: Number(guard.originalChars || 0) || 0,
    finalChars: Number(guard.finalChars || 0) || 0,
    reasons: Array.isArray(guard.reasons) ? guard.reasons : []
  });
}

module.exports = {
  GROUP_DIRECT_REPLY_CHAR_LIMIT,
  GROUP_DIRECT_REPLY_MAX_QUESTION_SENTENCES,
  GROUP_DIRECT_REPLY_MAX_SENTENCES,
  GROUP_DIRECT_REPLY_TARGET_MAX_CHARS,
  GROUP_DIRECT_REPLY_TARGET_MIN_CHARS,
  applyGroupDirectStyleGuard,
  buildGroupDirectStyleGuardReasons,
  createGroupDirectStyleGuardEvent,
  getRouteMetaGroupId,
  isGroupDirectChatRequest,
  splitChineseSentences,
  trimGroupDirectReplyText
};

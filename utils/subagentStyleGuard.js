const { humanizeReply } = require('./humanizer');
const { sanitizeUserFacingText } = require('./userFacingText');

const SUBAGENT_DEFAULT_MAX_CHARS = 1800;
const SUBAGENT_REVIEW_INPUT_MAX_CHARS = 3600;
const SUBAGENT_FINAL_FALLBACK_MAX_CHARS = 1400;
const SUBAGENT_MAX_QUESTION_SENTENCES = 1;

const TUTORIAL_TONE_PATTERNS = [
  /以下是/,
  /下面是/,
  /首先/,
  /其次/,
  /最后/,
  /总[结的]来说/,
  /总结一下/,
  /步骤/,
  /教程/,
  /提纲/,
  /核心逻辑/,
  /你需要先/,
  /建议你先/,
  /第一[，,、:：]/,
  /第二[，,、:：]/,
  /第三[，,、:：]/
];

function normalizePositiveInt(value, fallback, min = 1, max = 10000) {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function hasExplicitStructuredRequest(requestText = '') {
  const text = String(requestText || '').trim();
  if (!text) return false;
  return /markdown|代码块|表格|步骤|分步骤|教程|详细|完整|清单|列表|报告|方案|计划|review|diff|patch/i.test(text);
}

function countQuestionMarks(text = '') {
  return (String(text || '').match(/[？?]/g) || []).length;
}

function splitSentenceUnits(text = '') {
  const input = String(text || '').replace(/\r\n/g, '\n');
  if (!input.trim()) return [];
  return input.match(/[^。！？!?\n]+[。！？!?]?|\n+/g) || [input];
}

function reduceQuestionSentences(text = '', maxQuestions = SUBAGENT_MAX_QUESTION_SENTENCES) {
  const limit = normalizePositiveInt(maxQuestions, SUBAGENT_MAX_QUESTION_SENTENCES, 0, 5);
  if (limit <= 0 && !countQuestionMarks(text)) return String(text || '').trim();
  let keptQuestions = 0;
  const units = splitSentenceUnits(text);
  const kept = [];
  for (const unit of units) {
    if (/^\n+$/.test(unit)) {
      kept.push(unit);
      continue;
    }
    if (!/[？?]/.test(unit)) {
      kept.push(unit);
      continue;
    }
    keptQuestions += 1;
    if (keptQuestions <= limit) kept.push(unit);
  }
  return kept.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function softenTutorialTone(text = '', options = {}) {
  const preserveStructuredOutput = Boolean(options.preserveStructuredOutput);
  if (preserveStructuredOutput) return String(text || '').trim();

  return String(text || '')
    .replace(/(?:当然可以|当然|好的|没问题)[，,、:：\s]*/g, '')
    .replace(/(?:以下是|下面是)(?:我整理的|相关的|具体的|完整的|简要的)?(?:回复|答案|建议|方案|步骤|教程|总结|内容)?[：:,，、\s]*/g, '')
    .replace(/(?:首先|其次|然后|最后|总结一下|总的来说|总而言之|核心逻辑是)[：:,，、\s]*/g, '')
    .replace(/第[一二三四五六七八九十][，,、:：]/g, '')
    .replace(/完整教程[。！!，,、\s]*/g, '')
    .replace(/你需要先/g, '可以先')
    .replace(/建议你先/g, '可以先')
    .replace(/(\n|^)\s*#{1,6}\s*(?:结论|总结|步骤|教程|提纲)\s*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildSubagentStyleGuardReasons(text = '', options = {}) {
  const input = String(text || '').trim();
  const reasons = [];
  if (!input) return reasons;

  const maxChars = normalizePositiveInt(options.maxChars, SUBAGENT_DEFAULT_MAX_CHARS, 80, 10000);
  if (input.length > maxChars) reasons.push('too_long');
  if (countQuestionMarks(input) > normalizePositiveInt(options.maxQuestions, SUBAGENT_MAX_QUESTION_SENTENCES, 0, 5)) {
    reasons.push('too_many_questions');
  }
  if (!hasExplicitStructuredRequest(options.requestText) && TUTORIAL_TONE_PATTERNS.some((pattern) => pattern.test(input))) {
    reasons.push('tutorial_tone');
  }
  return reasons;
}

function trimToBudget(text = '', maxChars = SUBAGENT_DEFAULT_MAX_CHARS) {
  const input = String(text || '').trim();
  const limit = normalizePositiveInt(maxChars, SUBAGENT_DEFAULT_MAX_CHARS, 80, 10000);
  if (input.length <= limit) return input;
  if (/^```/.test(input)) return input;

  const hardLimit = Math.max(20, limit - 3);
  const candidate = input.slice(0, hardLimit);
  const stops = ['\n\n', '\n', '。', '！', '？', '；', ';', '.', '!', '?'];
  for (const stop of stops) {
    const index = candidate.lastIndexOf(stop);
    if (index >= Math.floor(limit * 0.45)) {
      return `${candidate.slice(0, index + stop.length).trim()}...`;
    }
  }
  return `${candidate.trim()}...`;
}

function normalizeSubagentOutputForMain(text = '', options = {}) {
  const requestText = String(options.requestText || '').trim();
  const preserveStructuredOutput = Boolean(options.preserveStructuredOutput)
    || hasExplicitStructuredRequest(requestText);
  const maxChars = normalizePositiveInt(options.maxChars, SUBAGENT_DEFAULT_MAX_CHARS, 80, 10000);
  const maxQuestions = normalizePositiveInt(options.maxQuestions, SUBAGENT_MAX_QUESTION_SENTENCES, 0, 5);

  let next = sanitizeUserFacingText(String(text || '')).trim();
  if (!next) return '';
  next = humanizeReply(next);
  next = softenTutorialTone(next, { preserveStructuredOutput });
  next = reduceQuestionSentences(next, maxQuestions);
  next = trimToBudget(next, maxChars);
  return next;
}

function prepareSubagentOutputForReview(text = '', options = {}) {
  return normalizeSubagentOutputForMain(text, {
    ...options,
    preserveStructuredOutput: true,
    maxChars: normalizePositiveInt(options.maxChars, SUBAGENT_REVIEW_INPUT_MAX_CHARS, 200, 12000),
    maxQuestions: normalizePositiveInt(options.maxQuestions, SUBAGENT_MAX_QUESTION_SENTENCES, 0, 5)
  });
}

function prepareSubagentFallbackReply(text = '', options = {}) {
  return normalizeSubagentOutputForMain(text, {
    ...options,
    maxChars: normalizePositiveInt(options.maxChars, SUBAGENT_FINAL_FALLBACK_MAX_CHARS, 120, 8000),
    maxQuestions: normalizePositiveInt(options.maxQuestions, SUBAGENT_MAX_QUESTION_SENTENCES, 0, 5)
  });
}

function buildSubagentStyleGuardInstruction(options = {}) {
  const maxChars = normalizePositiveInt(options.maxChars, SUBAGENT_DEFAULT_MAX_CHARS, 300, 10000);
  const maxQuestions = normalizePositiveInt(options.maxQuestions, SUBAGENT_MAX_QUESTION_SENTENCES, 0, 5);
  return [
    'Subagent style budget:',
    `- Output is for main-reply refill. Keep it within ${maxChars} Chinese chars unless the user explicitly asked for a long structured artifact.`,
    '- Avoid AI/tutorial/customer-service tone: no "以下是/首先/其次/最后/总结一下/你需要先/建议你先" scaffolding unless the user explicitly asked for a tutorial or steps.',
    `- Ask at most ${maxQuestions} short follow-up question; do not stack rhetorical questions.`,
    '- Prefer direct findings, evidence, limits, and final wording. Do not add polite filler or "hope this helps" closers.'
  ].join('\n');
}

module.exports = {
  SUBAGENT_DEFAULT_MAX_CHARS,
  SUBAGENT_FINAL_FALLBACK_MAX_CHARS,
  SUBAGENT_MAX_QUESTION_SENTENCES,
  SUBAGENT_REVIEW_INPUT_MAX_CHARS,
  buildSubagentStyleGuardInstruction,
  buildSubagentStyleGuardReasons,
  normalizeSubagentOutputForMain,
  prepareSubagentFallbackReply,
  prepareSubagentOutputForReview,
  trimToBudget
};

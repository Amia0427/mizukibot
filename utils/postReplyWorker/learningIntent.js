function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeLearningIntent(value = '') {
  const intent = normalizeText(value).toLowerCase();
  if (intent === 'explicit') return 'explicit';
  if (intent === 'implicit') return 'implicit';
  if (intent === 'journal_only' || intent === 'journal-only' || intent === 'journal') return 'journal_only';
  return '';
}

function isExplicitRememberText(text = '') {
  const value = normalizeText(text);
  if (!value) return false;
  return /(?:^|\n)(?:Turn\s+\d+\s+User:\s*)?(?:请)?(?:记住|记一下|帮我记住|remember)\s*(?:[:：,-]\s*|\s+)?\S+/i.test(value);
}

function normalizeTurnItems(job = {}, turns = undefined) {
  const source = turns === undefined ? job.turns : turns;
  const items = normalizeArray(source)
    .map((item) => normalizeObject(item, null))
    .filter(Boolean);
  if (items.length > 0) return items;
  const question = normalizeText(job.question);
  const finalReply = normalizeText(job.finalReply);
  return question || finalReply ? [{ question, finalReply }] : [];
}

function mergeLearningIntent(...values) {
  const normalized = values.map((item) => normalizeLearningIntent(item)).filter(Boolean);
  if (normalized.includes('explicit')) return 'explicit';
  if (normalized.includes('implicit')) return 'implicit';
  if (normalized.includes('journal_only')) return 'journal_only';
  return '';
}

function detectPostReplyLearningIntent(job = {}, turns = undefined) {
  const explicitIntent = normalizeLearningIntent(job.learningIntent || job.learning_intent);
  if (explicitIntent) return explicitIntent;

  const items = normalizeTurnItems(job, turns);
  if (items.some((item) => isExplicitRememberText(item.question))) return 'explicit';

  const tasks = normalizeObject(job.tasks, {});
  if (tasks.memoryLearning === true || tasks.selfImprovement === true) return 'implicit';
  if (tasks.dailyJournal === true) return 'journal_only';
  return 'journal_only';
}

module.exports = {
  detectPostReplyLearningIntent,
  isExplicitRememberText,
  mergeLearningIntent,
  normalizeLearningIntent
};

const { normalizeText } = require('./helpers');

const MEMORY_RECALL_POLICY_RESOURCE = Object.freeze({
  id: 'memory_v3_recall_policy',
  title: 'Memory V3 Recall Policy',
  text: [
    'Use recalled memory only when the current turn depends on prior facts, preferences, identity, tasks, group context, style, or recent continuity.',
    'Prefer explicit category/source matches over broad semantic similarity; recent/date queries should prefer continuity and journal sources.',
    'Do not use stale, suspect, superseded, archived, or scope-mismatched memory as factual evidence.',
    'If retrieved evidence is weak, treat it as background and avoid claiming certainty.'
  ].join('\n')
});

function getMemoryRecallPolicyResource(options = {}) {
  const category = normalizeText(options.category || options.memoryCategory);
  const sourcePlan = options.sourcePlan && typeof options.sourcePlan === 'object' ? options.sourcePlan : {};
  return {
    ...MEMORY_RECALL_POLICY_RESOURCE,
    category,
    sourcePlan: {
      source: normalizeText(sourcePlan.source),
      category: normalizeText(sourcePlan.category),
      reason: normalizeText(sourcePlan.reason)
    }
  };
}

module.exports = {
  MEMORY_RECALL_POLICY_RESOURCE,
  getMemoryRecallPolicyResource
};

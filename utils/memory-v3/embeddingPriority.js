const { normalizeText } = require('./helpers');

function createEmbeddingPriority(deps = {}) {
  const { isJournalEmbeddingDoc } = deps;

  function classifyEmbeddingPriority(node = {}) {
    const source = normalizeText(node.source).toLowerCase();
    const scopeType = normalizeText(node.scopeType).toLowerCase();
    const fieldKey = normalizeText(node.fieldKey || node.semanticSlot || node.type || node.memoryKind).toLowerCase();
    const type = normalizeText(node.type || node.memoryKind).toLowerCase();
    if (isJournalEmbeddingDoc(node)) return { priority: 'journal', rank: 10, reason: 'journal_doc' };
    if (
      source === 'profile'
      || fieldKey.includes('identity')
      || fieldKey.includes('persona')
      || fieldKey.includes('preference')
      || fieldKey === 'like'
      || fieldKey === 'dislike'
      || ['identity', 'summary', 'impression', 'like', 'dislike', 'hobby', 'personality'].includes(type)
    ) {
      return { priority: 'profile', rank: 20, reason: 'profile_or_preference' };
    }
    if (scopeType === 'task' || source === 'task' || fieldKey.includes('task')) {
      return { priority: 'task', rank: 30, reason: 'task_scope' };
    }
    if (scopeType === 'group' || source === 'group' || source === 'jargon') {
      return { priority: 'group', rank: 40, reason: 'group_scope' };
    }
    return { priority: 'other', rank: 90, reason: 'default' };
  }

  return {
    classifyEmbeddingPriority
  };
}

module.exports = {
  createEmbeddingPriority
};

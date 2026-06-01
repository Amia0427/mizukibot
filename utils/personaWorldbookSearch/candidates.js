const {
  normalizeText,
  tokenize,
  cosineFromTokenSets
} = require('../memory-v3/helpers');

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cosineArray(a = [], b = []) {
  const length = Math.min(Array.isArray(a) ? a.length : 0, Array.isArray(b) ? b.length : 0);
  if (length === 0) return 0;
  let dotSum = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const va = Number(a[i]) || 0;
    const vb = Number(b[i]) || 0;
    dotSum += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dotSum / (Math.sqrt(normA) * Math.sqrt(normB));
}

function lexicalScore(query = '', doc = {}) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const docTokens = tokenize(doc.text);
  const lexical = cosineFromTokenSets(queryTokens, docTokens);
  const compactQuery = normalizeText(query).toLowerCase().replace(/\s+/g, '');
  const compactText = normalizeText(doc.text).toLowerCase().replace(/\s+/g, '');
  const direct = compactQuery && compactText.includes(compactQuery) ? 0.35 : 0;
  const hintHit = normalizeArray(doc.triggerHints)
    .some((hint) => {
      const normalized = normalizeText(hint).toLowerCase().replace(/\s+/g, '');
      return normalized && (compactQuery.includes(normalized) || compactText.includes(compactQuery));
    }) ? 0.2 : 0;
  return lexical + direct + hintHit;
}

function normalizeCandidate(doc = {}, score = 0, matchMode = 'lexical', reason = '') {
  return {
    id: doc.moduleId,
    moduleId: doc.moduleId,
    score,
    matchMode,
    reason,
    phase: doc.phase,
    slot: doc.slot,
    conflictsWith: normalizeArray(doc.conflictsWith),
    tokenCost: doc.tokenCost,
    priority: doc.priority,
    purpose: doc.purpose,
    triggerHints: normalizeArray(doc.triggerHints),
    path: doc.path,
    activationMode: doc.activationMode,
    durationTurns: doc.durationTurns,
    durationMs: doc.durationMs,
    scope: normalizeArray(doc.scope),
    probability: doc.probability,
    template: doc.template,
    exampleIds: normalizeArray(doc.exampleIds),
    linkedExamples: normalizeArray(doc.exampleIds),
    text: doc.text
  };
}

function mergeCandidates(...groups) {
  const byId = new Map();
  for (const item of groups.flat().filter(Boolean)) {
    const moduleId = normalizeText(item.moduleId || item.id);
    if (!moduleId) continue;
    const existing = byId.get(moduleId);
    if (!existing || Number(item.score || 0) > Number(existing.score || 0)) {
      byId.set(moduleId, {
        ...existing,
        ...item,
        moduleId,
        id: moduleId,
        matchMode: existing && existing.matchMode !== item.matchMode ? 'hybrid' : item.matchMode
      });
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.priority || 0) - Number(b.priority || 0));
}

module.exports = {
  cosineArray,
  lexicalScore,
  mergeCandidates,
  normalizeArray,
  normalizeCandidate
};

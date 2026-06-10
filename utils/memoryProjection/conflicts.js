const { sanitizeText } = require('./common');

function tierRank(value = '') {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'S') return 4;
  if (normalized === 'A') return 3;
  if (normalized === 'B') return 2;
  if (normalized === 'C') return 1;
  return 0;
}

function sourceKindRank(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'explicit') return 5;
  if (normalized === 'journal') return 4;
  if (normalized === 'rollup') return 4;
  if (normalized === 'extractor') return 3;
  if (normalized === 'legacy') return 2;
  return 1;
}

function compareMemoryItems(a, b) {
  const statusA = String(a?.status || '').trim().toLowerCase();
  const statusB = String(b?.status || '').trim().toLowerCase();
  if (statusA !== statusB) {
    if (statusA === 'active') return -1;
    if (statusB === 'active') return 1;
  }

  const sourceDelta = sourceKindRank(b?.sourceKind) - sourceKindRank(a?.sourceKind);
  if (sourceDelta !== 0) return sourceDelta;

  const confidenceDelta = Number(b?.confidence || 0) - Number(a?.confidence || 0);
  if (confidenceDelta !== 0) return confidenceDelta;

  const importanceDelta = Number(b?.importance || 0) - Number(a?.importance || 0);
  if (importanceDelta !== 0) return importanceDelta;

  const tierDelta = tierRank(b?.tier) - tierRank(a?.tier);
  if (tierDelta !== 0) return tierDelta;

  return Number(b?.updatedAt || b?.createdAt || 0) - Number(a?.updatedAt || a?.createdAt || 0);
}

function dedupeAndSort(items = []) {
  return Array.from(items)
    .sort(compareMemoryItems)
    .filter((item, index, list) => {
      const text = sanitizeText(item?.text || item?.canonicalText || '');
      if (!text) return false;
      const key = `${String(item?.type || '').toLowerCase()}|${text.toLowerCase()}`;
      return list.findIndex((candidate) => {
        const candidateText = sanitizeText(candidate?.text || candidate?.canonicalText || '');
        return `${String(candidate?.type || '').toLowerCase()}|${candidateText.toLowerCase()}` === key;
      }) === index;
    });
}

function chooseConflictWinner(group = []) {
  const sorted = dedupeAndSort(group);
  return sorted[0] || null;
}

function buildConflictGroups(items = []) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = sanitizeText(item?.conflictKey || '');
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function makeConflictKey(userId, type, text) {
  const uid = sanitizeText(userId);
  const normalizedType = sanitizeText(type).toLowerCase();
  const normalizedText = sanitizeText(text).toLowerCase();
  if (!uid || !normalizedType || !normalizedText) return '';

  if (normalizedType === 'like' || normalizedType === 'dislike') {
    return `${uid}|preference|${normalizedText}`;
  }
  if (normalizedType === 'identity') {
    return `${uid}|identity|${normalizedText}`;
  }
  if (normalizedType === 'goal') {
    return `${uid}|goal|${normalizedText}`;
  }
  if (normalizedType === 'summary') {
    return `${uid}|summary|primary`;
  }
  if (normalizedType === 'impression') {
    return `${uid}|impression|primary`;
  }
  return '';
}

module.exports = {
  buildConflictGroups,
  chooseConflictWinner,
  compareMemoryItems,
  dedupeAndSort,
  makeConflictKey,
  sourceKindRank,
  tierRank
};

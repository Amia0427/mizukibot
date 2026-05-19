function createProfileIssueHelpers(deps = {}) {
  const { sanitizeText } = deps;

  function normalizeIssueList(values = []) {
    return (Array.isArray(values) ? values : [])
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        return {
          userId: sanitizeText(item.userId || ''),
          fieldKey: sanitizeText(item.fieldKey || ''),
          canonicalKey: sanitizeText(item.canonicalKey || ''),
          conflictKey: sanitizeText(item.conflictKey || ''),
          id: sanitizeText(item.id || ''),
          text: sanitizeText(item.text || ''),
          suppressedBy: sanitizeText(item.suppressedBy || ''),
          winnerText: sanitizeText(item.winnerText || ''),
          winnerId: sanitizeText(item.winnerId || ''),
          reason: sanitizeText(item.reason || '')
        };
      })
      .filter((item) => item && (item.text || item.conflictKey || item.reason));
  }

  return {
    normalizeIssueList
  };
}

module.exports = {
  createProfileIssueHelpers
};

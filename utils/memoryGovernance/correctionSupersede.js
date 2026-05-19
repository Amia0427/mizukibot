function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function canonicalizeText(value = '') {
  return normalizeText(value)
    .toLowerCase()
    .replace(/^(用户|user|我|他|她|ta)\s*/i, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStatus(value = 'active') {
  const status = normalizeText(value).toLowerCase();
  return status || 'active';
}

function normalizeSourceKind(item = {}) {
  return normalizeText(item.sourceKind || item.source || item.meta?.sourceKind || item.meta?.source).toLowerCase();
}

function sameScope(left = {}, right = {}) {
  if (normalizeText(left.userId) && normalizeText(right.userId) && normalizeText(left.userId) !== normalizeText(right.userId)) return false;
  if (normalizeText(left.groupId) || normalizeText(right.groupId)) return normalizeText(left.groupId) === normalizeText(right.groupId);
  return true;
}

function detectUserCorrection(text = '') {
  const value = normalizeText(text);
  if (!value) return { isCorrection: false, correctedFrom: '', correctedTo: '', reason: '' };
  const patterns = [
    /(?:不是|不对|错了|纠正一下|更正一下|改成|应该是)\s*[“"']?([^，。；;,.!?！？]{1,80})[”"']?\s*(?:，|,|。|;|；|\s)*(?:是|而是|应该是|改成|换成)\s*[“"']?([^，。；;,.!?！？]{1,120})/i,
    /(?:not|wrong|incorrect)\s+([^,.;!?]{1,80})\s+(?:but|it's|it is|should be)\s+([^,.;!?]{1,120})/i,
    /(?:别记|不要记|别再记)\s*[“"']?([^，。；;,.!?！？]{1,120})/i
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    return {
      isCorrection: true,
      correctedFrom: normalizeText(match[1] || ''),
      correctedTo: normalizeText(match[2] || ''),
      reason: match[2] ? 'explicit_replacement' : 'explicit_forget'
    };
  }
  if (/(不是|不对|错了|纠正|更正|别记|不要记|别再记|以后别|以后不要|actually|correction)/i.test(value)) {
    return {
      isCorrection: true,
      correctedFrom: '',
      correctedTo: '',
      reason: 'correction_signal'
    };
  }
  return { isCorrection: false, correctedFrom: '', correctedTo: '', reason: '' };
}

function correctionMatchesItem(correction = {}, item = {}, incoming = {}) {
  if (!sameScope(incoming, item)) return false;
  if (normalizeStatus(item.status) === 'archived') return false;
  const itemText = canonicalizeText(item.text || item.canonicalText);
  if (!itemText) return false;
  const conflictKey = normalizeText(incoming.conflictKey || incoming.meta?.conflictKey);
  if (conflictKey && conflictKey === normalizeText(item.conflictKey || item.meta?.conflictKey)) return true;
  const correctedFrom = canonicalizeText(correction.correctedFrom);
  if (correctedFrom && (itemText.includes(correctedFrom) || correctedFrom.includes(itemText))) return true;
  const incomingCanonical = canonicalizeText(incoming.canonicalText || incoming.text);
  if (incomingCanonical && normalizeText(item.conflictKey) && normalizeText(item.conflictKey) === normalizeText(incoming.conflictKey)) return true;
  return false;
}

function buildCorrectionSupersedePlan(items = [], incoming = {}, options = {}) {
  const sourceKind = normalizeSourceKind(incoming);
  const correction = options.correction || detectUserCorrection(incoming.text || incoming.canonicalText);
  if (!correction.isCorrection) {
    return {
      ok: true,
      correction,
      changed: 0,
      archiveIds: [],
      reason: 'not_correction'
    };
  }
  if (sourceKind && sourceKind !== 'explicit' && sourceKind !== 'manual') {
    return {
      ok: true,
      correction,
      changed: 0,
      archiveIds: [],
      reason: 'non_explicit_correction_needs_review'
    };
  }
  const incomingId = normalizeText(incoming.id || incoming.nodeId);
  const archiveIds = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = normalizeText(item?.id || item?.nodeId);
    if (!id || id === incomingId) continue;
    if (!correctionMatchesItem(correction, item, incoming)) continue;
    archiveIds.push(id);
  }
  return {
    ok: true,
    correction,
    changed: archiveIds.length,
    archiveIds,
    reason: archiveIds.length ? 'correction_supersedes_existing' : 'no_matching_memory'
  };
}

function applyCorrectionSupersedeToLibrary(library = { items: [] }, incoming = {}, options = {}) {
  const items = Array.isArray(library.items) ? library.items : [];
  const plan = buildCorrectionSupersedePlan(items, incoming, options);
  if (!plan.archiveIds.length) return { ...plan, library };
  const now = Math.max(0, Number(options.now || Date.now()) || Date.now());
  const ids = new Set(plan.archiveIds);
  for (const item of items) {
    if (!ids.has(normalizeText(item.id || item.nodeId))) continue;
    item.status = 'archived';
    item.updatedAt = now;
    item.meta = {
      ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
      archivedReason: 'user_correction_superseded',
      correction: {
        correctedFrom: plan.correction.correctedFrom,
        correctedTo: plan.correction.correctedTo,
        supersededBy: normalizeText(incoming.id || incoming.nodeId),
        at: now
      }
    };
  }
  incoming.supersedes = Array.from(new Set([...(Array.isArray(incoming.supersedes) ? incoming.supersedes : []), ...plan.archiveIds]));
  incoming.meta = {
    ...(incoming.meta && typeof incoming.meta === 'object' ? incoming.meta : {}),
    correctionSupersede: {
      reason: plan.reason,
      archiveIds: plan.archiveIds,
      correctedFrom: plan.correction.correctedFrom,
      correctedTo: plan.correction.correctedTo,
      at: now
    }
  };
  return { ...plan, library };
}

module.exports = {
  applyCorrectionSupersedeToLibrary,
  buildCorrectionSupersedePlan,
  canonicalizeText,
  detectUserCorrection
};

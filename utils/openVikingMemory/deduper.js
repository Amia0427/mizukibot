const {
  canonicalRecallText,
  clampNumber,
  diceCoefficient,
  normalizeArray,
  normalizeObject,
  normalizeText
} = require('./text');

function extractTextValues(value, output = [], depth = 0) {
  if (depth > 5 || value === null || value === undefined) return output;
  if (typeof value === 'string') {
    const text = normalizeText(value);
    if (text) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractTextValues(item, output, depth + 1);
    return output;
  }
  if (typeof value !== 'object') return output;
  const direct = normalizeText(
    value.text
    || value.content
    || value.preview
    || value.summary
    || value.memory
    || value.fact
    || value.value
  );
  if (direct) output.push(direct);
  for (const key of [
    'messages',
    'items',
    'hits',
    'results',
    'retrievedMemory',
    'weakEvidence',
    'dailyJournal',
    'taskMemory',
    'groupMemory',
    'styleSignals',
    'sessionContinuity',
    'longTermProfile'
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      extractTextValues(value[key], output, depth + 1);
    }
  }
  return output;
}

function collectLocalMemoryTexts(memoryContext = {}) {
  const context = normalizeObject(memoryContext, {});
  const sourceValues = [
    context.promptRetrievedMemoryText,
    context.retrievedMemoryForPrompt,
    context.memoryForPrompt,
    context.promptTaskMemoryText,
    context.taskMemoryText,
    context.promptGroupMemoryText,
    context.groupMemoryText,
    context.promptStyleSignalText,
    context.styleSignalText,
    context.promptDailyJournalText,
    context.dailyJournalText,
    context.promptLongTermProfileText,
    context.longTermProfileText,
    context.profileText,
    context.segments,
    context.hits,
    context.strictResults,
    context.weakResults
  ];
  const seen = new Set();
  return sourceValues
    .flatMap((value) => extractTextValues(value, []))
    .map((text) => normalizeText(text))
    .filter((text) => {
      const canonical = canonicalRecallText(text);
      if (!canonical || canonical.length < 6) return false;
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    });
}

function findDuplicateReason(itemText = '', localTexts = [], options = {}) {
  const canonical = canonicalRecallText(itemText);
  if (!canonical || canonical.length < 8) return '';
  const diceThreshold = clampNumber(options.diceThreshold, 0, 1, 0.82);
  const containmentThreshold = clampNumber(options.containmentThreshold, 0, 1, 0.85);
  const compact = canonical.replace(/\s+/g, '');
  for (const localText of localTexts) {
    const localCanonical = canonicalRecallText(localText);
    const localCompact = localCanonical.replace(/\s+/g, '');
    if (!localCompact) continue;
    if (localCompact === compact) return 'normalized_hash';
    const shorter = localCompact.length <= compact.length ? localCompact : compact;
    const longer = localCompact.length > compact.length ? localCompact : compact;
    if (shorter.length >= 10 && longer.includes(shorter) && shorter.length / Math.max(1, compact.length) >= containmentThreshold) {
      return 'containment';
    }
    if (Math.min(localCompact.length, compact.length) >= 10 && diceCoefficient(localCanonical, canonical) >= diceThreshold) {
      return 'ngram_dice';
    }
  }
  return '';
}

function extractNegationSignature(text = '') {
  const canonical = canonicalRecallText(text).replace(/\s+/g, '');
  if (!canonical) return null;
  const negated = /(不|不是|没有|没|讨厌|禁止|不要|不能|别|拒绝|avoid|never|not|no)/i.test(canonical);
  const positive = canonical
    .replace(/不(?=(?:喜欢|爱|想要|需要|接受|同意|可以|能|会|是))/g, '')
    .replace(/不(?!(?:喜欢|爱|想要|需要|接受|同意|可以|能|会|是))/g, '')
    .replace(/不是/g, '')
    .replace(/(?:没有|没|讨厌|禁止|不要|不能|别|拒绝|avoid|never|not|no)/gi, '')
    .replace(/\s+/g, '');
  if (positive.length < 6) return null;
  return { positive, negated };
}

function findConflictReason(itemText = '', localTexts = [], options = {}) {
  const itemSignature = extractNegationSignature(itemText);
  if (!itemSignature) return '';
  const threshold = clampNumber(options.conflictDiceThreshold, 0, 1, 0.68);
  for (const localText of localTexts) {
    const localSignature = extractNegationSignature(localText);
    if (!localSignature || localSignature.negated === itemSignature.negated) continue;
    if (
      localSignature.positive.includes(itemSignature.positive)
      || itemSignature.positive.includes(localSignature.positive)
      || diceCoefficient(localSignature.positive, itemSignature.positive) >= threshold
    ) {
      return 'remote_conflict_with_local';
    }
  }
  return '';
}

function dedupeOpenVikingRecallAgainstMemoryContext(recall = {}, memoryContext = {}, options = {}) {
  const payload = normalizeObject(recall, {});
  const items = normalizeArray(payload.items).filter((item) => normalizeText(item?.text || item?.content || item?.abstract || item?.overview));
  if (items.length === 0) return payload;
  const localTexts = collectLocalMemoryTexts(memoryContext);
  if (localTexts.length === 0) {
    return {
      ...payload,
      items,
      used: payload.used === true || items.length > 0,
      diagnostics: {
        ...normalizeObject(payload.diagnostics, {}),
        dedupe: {
          enabled: true,
          localEvidenceCount: 0,
          kept: items.length,
          removed: 0,
          removedItems: []
        }
      }
    };
  }

  const kept = [];
  const removedItems = [];
  const seen = new Set();
  for (const raw of items) {
    const item = normalizeObject(raw, {});
    const text = normalizeText(item.text || item.content || item.abstract || item.overview);
    const canonical = canonicalRecallText(text);
    if (!canonical || seen.has(canonical)) {
      removedItems.push({ id: item.id || item.uri || item.ref, reason: canonical ? 'openviking_internal_duplicate' : 'empty_canonical', text });
      continue;
    }
    seen.add(canonical);
    const duplicateReason = findDuplicateReason(text, localTexts, options);
    if (duplicateReason) {
      removedItems.push({ id: item.id || item.uri || item.ref, reason: duplicateReason, text });
      continue;
    }
    const conflictReason = findConflictReason(text, localTexts, options);
    if (conflictReason) {
      removedItems.push({ id: item.id || item.uri || item.ref, reason: conflictReason, text });
      continue;
    }
    kept.push({ ...item, text });
  }

  return {
    ...payload,
    items: kept,
    used: kept.length > 0,
    rejectedReason: kept.length > 0
      ? normalizeText(payload.rejectedReason)
      : (removedItems.length > 0 ? 'deduped_by_local_memory' : normalizeText(payload.rejectedReason, 'empty_result')),
    diagnostics: {
      ...normalizeObject(payload.diagnostics, {}),
      dedupe: {
        enabled: true,
        localEvidenceCount: localTexts.length,
        kept: kept.length,
        removed: removedItems.length,
        removedItems: removedItems.map((item) => ({
          id: normalizeText(item.id),
          reason: item.reason,
          textPreview: normalizeText(item.text).slice(0, 120)
        }))
      }
    }
  };
}

module.exports = {
  collectLocalMemoryTexts,
  dedupeOpenVikingRecallAgainstMemoryContext,
  findConflictReason,
  findDuplicateReason
};

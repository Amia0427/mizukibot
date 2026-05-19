const { formatMemosRecallPrompt } = require('./memosPlannerRecall');

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function canonicalRecallText(value = '') {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\[(?:memosrecall|retrievedmemorylite|retrievedmemory|relevantevidence|weakevidence|sessioncontinuity|taskmemory|groupmemory|stylesignals|dailyjournal|longtermprofile)\]/gi, ' ')
    .replace(/\b(?:use only as external memory evidence|prefer recent short-term context when it conflicts)\b/gi, ' ')
    .replace(/\b(?:score|time|date)\s*=\s*[\w:./+-]+/gi, ' ')
    .replace(/\bdate:\s*\d{4}-\d{2}-\d{2}\b/gi, ' ')
    .replace(/^\s*\d+[.)、]\s*/gm, ' ')
    .replace(/[，。！？；：、,.!?;:]/g, ' ')
    .replace(/(?:然后|并且|而且|以及|另外|同时|先|再|会|了|的)/g, ' ')
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function charNgrams(text = '', n = 3) {
  const compact = canonicalRecallText(text).replace(/\s+/g, '');
  if (!compact) return [];
  if (compact.length <= n) return [compact];
  const grams = [];
  for (let i = 0; i <= compact.length - n; i += 1) {
    grams.push(compact.slice(i, i + n));
  }
  return grams;
}

function diceCoefficient(a = '', b = '') {
  const gramsA = charNgrams(a);
  const gramsB = charNgrams(b);
  if (gramsA.length === 0 || gramsB.length === 0) return 0;
  const counts = new Map();
  for (const gram of gramsA) counts.set(gram, (counts.get(gram) || 0) + 1);
  let overlap = 0;
  for (const gram of gramsB) {
    const count = counts.get(gram) || 0;
    if (count <= 0) continue;
    overlap += 1;
    if (count === 1) counts.delete(gram);
    else counts.set(gram, count - 1);
  }
  return (2 * overlap) / (gramsA.length + gramsB.length);
}

function extractNumberedMemosPromptItems(promptText = '') {
  const text = normalizeText(promptText);
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[.)、]\s*/, '').trim())
    .filter((line) => line && !/^\[memosrecall\]$/i.test(line) && !/^use only as external memory evidence/i.test(line));
}

function normalizeMemosItems(memosRecall = {}) {
  const recall = normalizeObject(memosRecall, {});
  const items = normalizeArray(recall.items)
    .map((item, index) => ({
      ...normalizeObject(item, {}),
      id: normalizeText(item?.id || item?.memory_id || item?.ref || `memos_${index + 1}`),
      text: normalizeText(item?.text || item?.content || item?.memory || item?.summary),
      score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null,
      createdAt: normalizeText(item?.createdAt || item?.created_at || item?.time || item?.timestamp)
    }))
    .filter((item) => item.text);
  const seen = new Set(items.map((item) => canonicalRecallText(item.text)).filter(Boolean));
  const promptItems = extractNumberedMemosPromptItems(recall.promptText)
    .map((text, index) => ({
      id: `memos_prompt_${index + 1}`,
      text,
      score: null,
      createdAt: ''
    }))
    .filter((item) => {
      const canonical = canonicalRecallText(item.text);
      if (!canonical || seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    });
  return [...items, ...promptItems];
}

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
    context.weakResults,
    context.journalHits,
    context.taskHits,
    context.groupHits,
    context.styleHits
  ];
  const seen = new Set();
  return sourceValues
    .flatMap((value) => extractTextValues(value, []))
    .map((text) => normalizeText(text))
    .filter((text) => {
      const canonical = canonicalRecallText(text);
      if (!canonical || canonical.length < 8) return false;
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    });
}

function findDuplicateReason(itemText = '', localTexts = [], options = {}) {
  const canonical = canonicalRecallText(itemText);
  if (!canonical || canonical.length < 8) return '';
  const diceThreshold = Number.isFinite(Number(options.diceThreshold))
    ? Number(options.diceThreshold)
    : 0.82;
  const containmentThreshold = Number.isFinite(Number(options.containmentThreshold))
    ? Number(options.containmentThreshold)
    : 0.85;
  for (const localText of localTexts) {
    const localCanonical = canonicalRecallText(localText);
    if (!localCanonical) continue;
    if (localCanonical === canonical) return 'normalized_hash';
    const localCompact = localCanonical.replace(/\s+/g, '');
    const compact = canonical.replace(/\s+/g, '');
    if (localCompact && compact && localCompact === compact) return 'normalized_hash';
    const shorter = localCompact.length <= compact.length ? localCompact : compact;
    const longer = localCompact.length > compact.length ? localCompact : compact;
    if (shorter.length >= 10 && longer.includes(shorter) && shorter.length / Math.max(1, compact.length) >= containmentThreshold) {
      return 'containment';
    }
    if (shorter.length >= 10 && longer.includes(shorter) && shorter.length / Math.max(1, localCompact.length) >= containmentThreshold) {
      return 'containment';
    }
    if (Math.min(localCompact.length, compact.length) >= 10 && diceCoefficient(localCanonical, canonical) >= diceThreshold) {
      return 'ngram_dice';
    }
  }
  return '';
}

function dedupeMemosRecallAgainstMemoryContext(memosRecall = {}, memoryContext = {}, options = {}) {
  const recall = normalizeObject(memosRecall, {});
  const items = normalizeMemosItems(recall);
  if (items.length === 0) return recall;
  const localTexts = collectLocalMemoryTexts(memoryContext);
  if (localTexts.length === 0) return {
    ...recall,
    items,
    used: recall.used === true || items.length > 0,
    promptText: normalizeText(recall.promptText) || formatMemosRecallPrompt(items, {
      maxChars: options.maxChars
    }),
    diagnostics: {
      ...normalizeObject(recall.diagnostics, {}),
      dedupe: {
        enabled: true,
        localEvidenceCount: 0,
        kept: items.length,
        removed: 0,
        removedItems: []
      }
    }
  };

  const kept = [];
  const removedItems = [];
  const seen = new Set();
  for (const item of items) {
    const canonical = canonicalRecallText(item.text);
    if (!canonical || seen.has(canonical)) {
      removedItems.push({
        id: item.id,
        reason: canonical ? 'memos_internal_duplicate' : 'empty_canonical',
        text: item.text
      });
      continue;
    }
    seen.add(canonical);
    const reason = findDuplicateReason(item.text, localTexts, options);
    if (reason) {
      removedItems.push({
        id: item.id,
        reason,
        text: item.text
      });
      continue;
    }
    kept.push(item);
  }

  const maxChars = clampNumber(options.maxChars, 120, 8000, 900);
  const nextPromptText = kept.length > 0
    ? formatMemosRecallPrompt(kept, { maxChars })
    : '';
  return {
    ...recall,
    items: kept,
    used: kept.length > 0,
    rejectedReason: kept.length > 0
      ? normalizeText(recall.rejectedReason)
      : (removedItems.length > 0 ? 'deduped_by_local_memory' : normalizeText(recall.rejectedReason, 'empty_result')),
    promptText: nextPromptText,
    diagnostics: {
      ...normalizeObject(recall.diagnostics, {}),
      dedupe: {
        enabled: true,
        localEvidenceCount: localTexts.length,
        kept: kept.length,
        removed: removedItems.length,
        removedItems: removedItems.map((item) => ({
          id: item.id,
          reason: item.reason,
          text: normalizeText(item.text).slice(0, 160)
        }))
      }
    }
  };
}

module.exports = {
  canonicalRecallText,
  collectLocalMemoryTexts,
  dedupeMemosRecallAgainstMemoryContext,
  diceCoefficient,
  findDuplicateReason,
  normalizeMemosItems
};

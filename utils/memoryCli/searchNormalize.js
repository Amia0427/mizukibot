const config = require('../../config');
const { sanitizeText } = require('./commandParser');
const { sanitizePreviewText } = require('./text');

function normalizeVectorHit(hit, source) {
  if (!hit || typeof hit !== 'object') return null;
  const text = sanitizeText(hit.text || hit.content || hit.preview || hit.canonicalText || '');
  const preview = sanitizePreviewText(text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS);
  if (!text) return null;
  return {
    ref: `mc_ref:${source}:${String(hit.id || '').trim()}`,
    source,
    type: String(hit.type || 'fact').trim() || 'fact',
    id: String(hit.id || '').trim(),
    logicalId: String(hit.id || '').trim(),
    title: String(hit.type || source || 'memory').trim(),
    preview,
    text,
    score: Number(hit.score || 0) || 0,
    updatedAt: Number(hit.ts || hit.updatedAt || 0) || 0,
    confidence: Number(hit.confidence || 0) || 0,
    tier: String(hit.tier || '').trim() || 'B',
    matchMode: 'lexical',
    importance: Number(hit.importance || 0) || 0,
    groupId: String(hit.groupId || '').trim(),
    taskType: String(hit.taskType || '').trim(),
    memoryKind: sanitizeText(hit.memoryKind || hit.meta?.memoryKind).toLowerCase(),
    scopeType: sanitizeText(hit.scopeType || ''),
    jargonRole: sanitizeText(hit.jargonRole || hit.meta?.jargonRole).toLowerCase(),
    styleRole: sanitizeText(hit.styleRole || hit.meta?.styleRole).toLowerCase()
  };
}

function classifyMemoryHitSource(hit = {}) {
  const memoryKind = sanitizeText(hit.memoryKind || hit.meta?.memoryKind).toLowerCase();
  if (memoryKind === 'style') return 'style';
  if (memoryKind === 'jargon') return 'jargon';
  if (memoryKind === 'episode' || String(hit.type || '').trim().toLowerCase() === 'episode' || sanitizeText(hit.sourceKind).toLowerCase() === 'journal') {
    return 'journal';
  }
  const scopeType = sanitizeText(hit.scopeType).toLowerCase();
  if (scopeType === 'task') return 'task';
  if (scopeType === 'group') return 'group';
  return 'personal';
}

function normalizeUnifiedHit(hit = {}) {
  const source = sanitizeText(hit.source || classifyMemoryHitSource(hit)).toLowerCase() || 'personal';
  const normalized = normalizeVectorHit(hit, source);
  if (!normalized) return null;
  return {
    ...normalized,
    source,
    status: sanitizeText(hit.status || 'active').toLowerCase() || 'active',
    sourceKind: sanitizeText(hit.sourceKind || 'legacy').toLowerCase() || 'legacy',
    reason: sanitizeText(hit.reason || ''),
    participantsMatched: Array.isArray(hit.participantsMatched) ? hit.participantsMatched : [],
    graphBoost: Number(hit.graphBoost || 0) || 0,
    recencyScore: Number(hit.recencyScore || 0) || 0,
    finalScore: Number(hit.score || 0) || 0
  };
}

function normalizeImageHit(hit = {}) {
  const cacheKey = sanitizeText(hit.cacheKey);
  if (!cacheKey) return null;
  const title = hit.summary ? 'Image memory' : 'Cached image';
  const fallbackText = [
    hit.summary,
    hit.ocrText || hit.visibleText,
    hit.userText,
    hit.sourceUrl,
    hit.messageId
  ].map(sanitizeText).filter(Boolean).join('\n');
  const text = sanitizeText(hit.text) || fallbackText;
  return {
    ref: `mc_ref:image:${cacheKey}`,
    source: 'image',
    type: 'cached_image',
    id: cacheKey,
    logicalId: cacheKey,
    title,
    preview: sanitizePreviewText(text || hit.imageRef || cacheKey, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
    text: text || hit.imageRef || cacheKey,
    score: Number(hit.score || 0) || 0,
    updatedAt: Number(hit.lastSeenAt || hit.createdAt || 0) || 0,
    confidence: hit.exists === false ? 0.5 : 0.86,
    tier: hit.exists === false ? 'C' : 'B',
    matchMode: 'image_index',
    status: hit.exists === false ? 'missing_payload' : 'active',
    sourceKind: 'image_memory',
    memoryKind: 'image',
    reason: hit.exists === false ? 'cached image payload missing' : ''
  };
}

module.exports = {
  classifyMemoryHitSource,
  normalizeImageHit,
  normalizeUnifiedHit,
  normalizeVectorHit
};

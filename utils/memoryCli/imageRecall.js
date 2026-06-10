const config = require('../../config');
const { isImageRecallQuery, searchImageMemories } = require('../imageMemoryIndex');
const { sanitizeText } = require('./commandParser');

function normalizeImageSearchHit(hit = {}) {
  const cacheKey = sanitizeText(hit.cacheKey);
  if (!cacheKey) return null;
  const text = sanitizeText([
    hit.text,
    hit.summary,
    hit.ocrText || hit.visibleText,
    hit.userText,
    hit.messageId
  ].filter(Boolean).join(' ')) || cacheKey;
  return {
    ref: `mc_ref:image:${cacheKey}`,
    source: 'image',
    type: 'cached_image',
    id: cacheKey,
    title: hit.summary ? 'Image memory' : 'Cached image',
    preview: text.slice(0, Math.max(24, Number(config.MEMORY_CLI_RESULT_PREVIEW_CHARS || 180) || 180)),
    text,
    score: Number(hit.score || 0).toFixed(3),
    updatedAt: Number(hit.lastSeenAt || hit.createdAt || 0) || 0,
    confidence: hit.exists === false ? 0.5 : 0.86,
    tier: hit.exists === false ? 'C' : 'B',
    matchMode: 'image_index',
    status: hit.exists === false ? 'missing_payload' : 'active',
    evidenceQuality: hit.exists === false ? 'weak' : 'strong',
    qualityReasons: hit.exists === false ? ['image_payload_missing'] : ['trusted_source:image', 'image_index_match'],
    sourceKind: 'image_memory',
    memoryKind: 'image'
  };
}

function mergeImageSearchIntoPayload(payload = {}, query = '', context = {}, limit = 8) {
  if (!payload || !isImageRecallQuery(query)) return payload;
  const imageResults = searchImageMemories(query, context, { limit })
    .map(normalizeImageSearchHit)
    .filter(Boolean);
  if (!imageResults.length) return payload;
  const seen = new Set((Array.isArray(payload.results) ? payload.results : []).map((item) => String(item.ref || '').trim()).filter(Boolean));
  const mergedImages = imageResults.filter((item) => !seen.has(item.ref));
  if (!mergedImages.length) return payload;
  const maxResults = Math.max(1, Math.min(20, Number(limit || payload.results?.length || 8) || 8));
  const results = (Array.isArray(payload.results) ? payload.results : []).concat(mergedImages)
    .sort((a, b) => {
      const aImage = a.source === 'image' ? 1 : 0;
      const bImage = b.source === 'image' ? 1 : 0;
      if (aImage !== bImage) return bImage - aImage;
      if (Number(b.score || 0) !== Number(a.score || 0)) return Number(b.score || 0) - Number(a.score || 0);
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    })
    .slice(0, maxResults);
  const sourceCoverage = {};
  for (const item of results) {
    sourceCoverage[item.source] = (sourceCoverage[item.source] || 0) + 1;
  }
  const qualityCounts = {};
  for (const item of results) {
    const quality = item.evidenceQuality || 'usable';
    qualityCounts[quality] = (qualityCounts[quality] || 0) + 1;
  }
  const rejectedResultCount = Number(payload.rejectedResultCount || 0) || 0;
  return {
    ...payload,
    count: results.length,
    results,
    digest: Array.from(new Set([
      ...(Array.isArray(payload.digest) ? payload.digest : []),
      ...mergedImages.map((item) => `[image] ${item.preview}`).slice(0, 3)
    ])).slice(0, 5),
    sourceCoverage,
    rejectedResultCount,
    qualitySummary: {
      ...(payload.qualitySummary || {}),
      hasUsableEvidence: results.some((item) => item.evidenceQuality === 'strong' || item.evidenceQuality === 'usable'),
      topResultQuality: results[0]?.evidenceQuality || payload.qualitySummary?.topResultQuality || '',
      counts: {
        ...(payload.qualitySummary?.counts || {}),
        ...qualityCounts
      },
      rejectedResultCount
    },
    candidateCounts: {
      ...(payload.candidateCounts || {}),
      image: (Number(payload.candidateCounts?.image || 0) || 0) + imageResults.length
    }
  };
}

module.exports = {
  mergeImageSearchIntoPayload,
  normalizeImageSearchHit
};

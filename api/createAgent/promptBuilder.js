const crypto = require('crypto');
const { normalizeRequestedImageSize } = require('./config');

function normalizePromptText(prompt = '') {
  return String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildResolutionQualityClause(imageSize = '') {
  const normalizedSize = normalizeRequestedImageSize(imageSize);
  const sizeMatch = normalizedSize.match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!sizeMatch) {
    return 'Target native high-resolution clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
  }

  const width = Number(sizeMatch[1] || 0);
  const height = Number(sizeMatch[2] || 0);
  const longestEdge = Math.max(width, height);
  if (longestEdge >= 3840) {
    return 'Target true 4K-class clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
  }
  if (longestEdge >= 2048) {
    return 'Target true 2K-class clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
  }
  if (longestEdge >= 1536) {
    return 'Target high-resolution clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
  }
  return 'Target clean high-resolution clarity with strong micro-detail preservation, clean edges, precise textures, and high subject-background separation.';
}

function buildCreateAgentPrompt(rawPrompt = '', options = {}) {
  const prompt = normalizePromptText(rawPrompt);
  if (!prompt) return '';

  const effectiveSize = normalizeRequestedImageSize(options.imageSize || '');
  const hasSizeHint = /(1024|1536|2048|4096|1k|2k|4k|1080p|high[- ]?res|high resolution|ultra)/i.test(prompt);
  const hasPhotoHint = /(照片|摄影|真实|写实|photoreal|photo[- ]?real|iphone photo|realistic)/i.test(prompt);
  const hasNoTextHint = /(不要文字|无文字|no text|without text|不要水印|no watermark)/i.test(prompt);
  const hasCompositionHint = /(竖图|横图|方图|portrait|landscape|square|9:16|16:9|手机截图|海报|poster|screenshot)/i.test(prompt);
  const hasSharpnessHint = /(清晰|锐利|锐度|sharp|crisp|high detail|fine detail|ultra detailed|detailed skin|clean lineart|clean linework)/i.test(prompt);
  const hasAntiBlurHint = /(不要模糊|避免模糊|no blur|avoid blur|sharp focus|in focus|clear edges|anti[- ]blur)/i.test(prompt);

  const clauses = [prompt];
  if (!hasPhotoHint) {
    clauses.push('Use clean composition and natural lighting with coherent details.');
  }
  if (!hasSharpnessHint) {
    clauses.push('Prioritize crisp focus, sharp edges, clean linework, high local contrast, and dense fine details.');
  }
  if (!hasAntiBlurHint) {
    clauses.push('Avoid blur, softness, haze, washed-out textures, smeared details, and low-detail backgrounds.');
  }
  clauses.push(buildResolutionQualityClause(effectiveSize));
  clauses.push('Preserve facial features, eyes, hands, hair strands, clothing textures, object edges, and small foreground details without mushiness.');
  if (!hasNoTextHint) {
    clauses.push('No text, watermark, UI, screenshot, or logo.');
  }
  if (!hasCompositionHint) {
    clauses.push('Render it as a polished single-image composition.');
  }
  if (!hasSizeHint) {
    clauses.push(`Prefer a polished single-image composition suitable for a ${effectiveSize === 'auto' ? 'native high-quality image output' : effectiveSize + ' output'}.`);
  }
  return clauses.join(' ');
}

function buildOutputBasename(prompt = '') {
  const datePart = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const normalized = normalizePromptText(prompt)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${datePart}-${normalized || 'create'}-${suffix}`;
}

module.exports = {
  normalizePromptText,
  buildResolutionQualityClause,
  buildCreateAgentPrompt,
  buildOutputBasename
};

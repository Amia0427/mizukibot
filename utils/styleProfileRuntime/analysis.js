const {
  MAX_COMMON_ENDINGS,
  normalizeText,
  nowMs
} = require('./common');
const {
  defaultProfile,
  normalizeProfile,
  normalizeSamples
} = require('./profileShape');

function countMatches(samples = [], predicate) {
  let count = 0;
  for (const item of samples) {
    if (predicate(item)) count += 1;
  }
  return count;
}

function detectSentenceLength(samples = []) {
  if (!samples.length) return '';
  const lengths = samples
    .map((item) => Array.from(String(item.text || '').replace(/\s+/g, '')).length)
    .filter((num) => num > 0)
    .sort((a, b) => a - b);
  if (!lengths.length) return '';
  const mid = lengths[Math.floor(lengths.length / 2)];
  if (mid <= 12) return 'short';
  if (mid <= 26) return 'medium';
  return 'long';
}

function isQuestionLike(text = '') {
  const input = String(text || '');
  return /[?？]$/.test(input) || /吗[?？]?$/i.test(input) || /不是.+吗/.test(input);
}

function isMemeCue(text = '') {
  return /(哈哈|hhh|草|绷|笑死|典|逆天|离谱|乐|蚌|拿捏|抽象)/i.test(String(text || ''));
}

function isTeaseCue(text = '') {
  return /(又|还在|别装|逮到|偷看|你这|怎么又|是不是又|还没|又来)/i.test(String(text || ''));
}

function isSubjectOmissionLikely(text = '') {
  const input = normalizeText(text, 80);
  if (!input) return false;
  if (/^(我|你|他|她|它|这|那|bot|瑞希)/i.test(input)) return false;
  return /^(在|有|没|还|先|快|别|去|看|来了|回头|行|可以|感觉|好像|应该|像是|直接|先别)/.test(input);
}

function detectCommonEndings(samples = []) {
  const counts = new Map();
  for (const item of samples) {
    const text = normalizeText(item.text, 80).replace(/[。！？!?~～\s]+$/g, '');
    if (!text) continue;
    const last1 = text.slice(-1);
    const last2 = text.slice(-2);
    if (/^[呀啦嘛呢哦哇欸诶捏喔哈]$/.test(last1)) {
      counts.set(last1, (counts.get(last1) || 0) + 1);
    }
    if (/^(了呀|呢呀|嘛呀|啦呀|是吧|对吧|好嘛|好啦|来了|没呢)$/.test(last2)) {
      counts.set(last2, (counts.get(last2) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_COMMON_ENDINGS)
    .map(([text]) => text);
}

function detectToneTags(samples = [], ratios = {}) {
  const tags = [];
  const softCount = countMatches(samples, (item) => /[呀啦嘛呢哇诶欸呐哦]/.test(item.text));
  const emojiCount = countMatches(samples, (item) => /[~～><QAQ^_^._]/.test(item.text));
  const softRatio = samples.length ? softCount / samples.length : 0;
  const emojiRatio = samples.length ? emojiCount / samples.length : 0;
  if (softRatio >= 0.28) tags.push('light_colloquial');
  if (emojiRatio >= 0.18) tags.push('cute');
  if (ratios.memeCueRatio >= 0.22) tags.push('playful');
  if (ratios.teaseCueRatio >= 0.22) tags.push('light_tease');
  if (ratios.subjectOmissionRatio >= 0.3) tags.push('concise');
  return tags.slice(0, 4);
}

function buildProfileFromSamples(samples = []) {
  const botSamples = normalizeSamples(samples).filter((item) => item.kind === 'bot' && item.text);
  const sampleCount = botSamples.length;
  if (!sampleCount) return defaultProfile();
  const rhetoricalQuestionRatio = sampleCount ? countMatches(botSamples, (item) => isQuestionLike(item.text)) / sampleCount : 0;
  const memeCueRatio = sampleCount ? countMatches(botSamples, (item) => isMemeCue(item.text)) / sampleCount : 0;
  const teaseCueRatio = sampleCount ? countMatches(botSamples, (item) => isTeaseCue(item.text)) / sampleCount : 0;
  const subjectOmissionRatio = sampleCount ? countMatches(botSamples, (item) => isSubjectOmissionLikely(item.text)) / sampleCount : 0;
  return normalizeProfile({
    toneTags: detectToneTags(botSamples, { memeCueRatio, teaseCueRatio, subjectOmissionRatio }),
    sentenceLength: detectSentenceLength(botSamples),
    rhetoricalQuestionRatio,
    memeCueRatio,
    teaseCueRatio,
    subjectOmissionRatio,
    commonEndings: detectCommonEndings(botSamples),
    sampleCount,
    updatedAt: nowMs()
  });
}

module.exports = {
  buildProfileFromSamples,
  countMatches,
  detectCommonEndings,
  detectSentenceLength,
  detectToneTags,
  isMemeCue,
  isQuestionLike,
  isSubjectOmissionLikely,
  isTeaseCue
};

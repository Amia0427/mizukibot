const config = require('../config');
const {
  GLOBAL_SAMPLE_LIMIT,
  GLOBAL_WINDOW_MS,
  GROUP_SAMPLE_LIMIT,
  GROUP_WINDOW_MS,
  STORE_FILE,
  normalizeId
} = require('./styleProfileRuntime/common');
const {
  defaultProfile,
  ensureGroupEntry,
  normalizeProfile,
  normalizeSample,
  pruneSamples
} = require('./styleProfileRuntime/profileShape');
const { buildProfileFromSamples } = require('./styleProfileRuntime/analysis');
const {
  readStore,
  writeStore
} = require('./styleProfileRuntime/store');

function recordBotReply(entry = {}) {
  if (!config.STYLE_PROFILE_ENABLED) return null;
  const sample = normalizeSample(entry, 'bot');
  if (!sample.text) return null;
  const store = readStore();
  store.globalBotBase.samples = pruneSamples([...store.globalBotBase.samples, sample], {
    cutoffMs: GLOBAL_WINDOW_MS,
    limit: GLOBAL_SAMPLE_LIMIT
  });
  store.globalBotBase.profile = buildProfileFromSamples(store.globalBotBase.samples);

  if (sample.groupId) {
    const groupEntry = ensureGroupEntry(store, sample.groupId);
    if (groupEntry) {
      groupEntry.samples = pruneSamples([...groupEntry.samples, sample], {
        cutoffMs: GROUP_WINDOW_MS,
        limit: GROUP_SAMPLE_LIMIT
      });
      groupEntry.profile = buildProfileFromSamples(groupEntry.samples);
    }
  }
  writeStore(store);
  return sample;
}

function recordHumanGroupMessage(entry = {}) {
  if (!config.STYLE_PROFILE_ENABLED) return null;
  const sample = normalizeSample(entry, 'human');
  if (!sample.text || !sample.groupId) return null;
  const store = readStore();
  const groupEntry = ensureGroupEntry(store, sample.groupId);
  if (!groupEntry) return null;
  groupEntry.samples = pruneSamples([...groupEntry.samples, sample], {
    cutoffMs: GROUP_WINDOW_MS,
    limit: GROUP_SAMPLE_LIMIT
  });
  groupEntry.profile = buildProfileFromSamples(groupEntry.samples);
  writeStore(store);
  return sample;
}

function isActiveProfile(profile = {}, minSamples = 1) {
  return Number(profile?.sampleCount || 0) >= Math.max(1, Number(minSamples || 1));
}

function getStyleProfile(groupId = '') {
  const store = readStore();
  const globalProfile = normalizeProfile(store.globalBotBase?.profile);
  const groupProfile = groupId ? normalizeProfile(store.groupOverlays?.[String(groupId)]?.profile) : defaultProfile();
  return {
    globalBotBase: globalProfile,
    groupOverlay: groupProfile
  };
}

function buildProfileSummary(profile = {}, { label = '', includeSampleCount = false } = {}) {
  const normalized = normalizeProfile(profile);
  if (!normalized.sampleCount) return '';
  const parts = [];
  if (normalized.toneTags.length) parts.push(`tone=${normalized.toneTags.join('/')}`);
  if (normalized.sentenceLength) parts.push(`length=${normalized.sentenceLength}`);
  if (normalized.rhetoricalQuestionRatio >= 0.25) parts.push('rhetorical_question=often');
  if (normalized.memeCueRatio >= 0.22) parts.push('meme=light');
  if (normalized.teaseCueRatio >= 0.22) parts.push('tease=light');
  if (normalized.subjectOmissionRatio >= 0.3) parts.push('subject_omission=often');
  if (normalized.commonEndings.length) parts.push(`endings=${normalized.commonEndings.join('/')}`);
  if (includeSampleCount) parts.push(`samples=${normalized.sampleCount}`);
  if (!parts.length) return '';
  return `${label}${parts.join(', ')}`;
}

function buildStyleProfileSnippet(input = {}) {
  if (!config.STYLE_PROFILE_ENABLED) return '';
  const maxChars = Math.max(80, Number(input.maxChars || config.STYLE_PROFILE_PROMPT_MAX_CHARS || 220));
  const groupId = normalizeId(input.groupId || input.group_id || '');
  const { globalBotBase, groupOverlay } = getStyleProfile(groupId);
  const lines = ['[StyleProfile]'];
  if (isActiveProfile(globalBotBase, 12)) {
    const globalText = buildProfileSummary(globalBotBase, { label: 'stable: ' });
    if (globalText) lines.push(globalText);
  }
  if (groupId && isActiveProfile(groupOverlay, 4)) {
    const groupText = buildProfileSummary(groupOverlay, { label: 'group_shift: ' });
    if (groupText) lines.push(groupText);
  }
  if (lines.length <= 1) return '';
  const text = lines.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function formatStyleProfileAsText(groupId = '') {
  const { globalBotBase, groupOverlay } = getStyleProfile(groupId);
  const lines = ['[StyleProfile]'];
  if (globalBotBase.sampleCount) {
    lines.push(`global: ${buildProfileSummary(globalBotBase, { includeSampleCount: true })}`);
  } else {
    lines.push('global: no stable profile yet');
  }
  if (groupId) {
    if (groupOverlay.sampleCount) {
      lines.push(`group(${groupId}): ${buildProfileSummary(groupOverlay, { includeSampleCount: true })}`);
    } else {
      lines.push(`group(${groupId}): no stable overlay yet`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  STORE_FILE,
  buildStyleProfileSnippet,
  formatStyleProfileAsText,
  getStyleProfile,
  readStore,
  recordBotReply,
  recordHumanGroupMessage
};

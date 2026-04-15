const fs = require('fs');
const path = require('path');
const config = require('../config');
const { createJsonHotStore } = require('./jsonHotStore');

const STORE_FILE = String(config.STYLE_PROFILE_STORE_FILE || path.join(config.DATA_DIR, 'style_profile.json')).trim();
const STYLE_STORE_DIR = path.join(path.dirname(STORE_FILE), 'style');
const STYLE_GLOBAL_FILE = path.join(STYLE_STORE_DIR, 'global.json');
const STYLE_GROUP_DIR = path.join(STYLE_STORE_DIR, 'group');
const GLOBAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const GROUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const GLOBAL_SAMPLE_LIMIT = 400;
const GROUP_SAMPLE_LIMIT = 300;
const MAX_COMMON_ENDINGS = 4;
const styleRuntimeStores = {
  legacy: null,
  global: null,
  groups: new Map()
};

function nowMs() {
  return Date.now();
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function atomicWriteJson(filePath, data) {
  const tempFile = `${filePath}.${process.pid}.tmp`;
  const body = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tempFile, body, 'utf8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, body, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM') throw error;
  }
}

function getLegacyStore() {
  if (!styleRuntimeStores.legacy) {
    styleRuntimeStores.legacy = createJsonHotStore(STORE_FILE, {
      fallback: defaultStore
    });
  }
  return styleRuntimeStores.legacy;
}

function getGlobalStore() {
  if (!styleRuntimeStores.global) {
    styleRuntimeStores.global = createJsonHotStore(STYLE_GLOBAL_FILE, {
      fallback: () => ({
        version: 1,
        profile: defaultProfile(),
        samples: []
      })
    });
  }
  return styleRuntimeStores.global;
}

function getGroupStore(groupId = '') {
  const gid = normalizeId(groupId);
  if (!gid) return null;
  if (!styleRuntimeStores.groups.has(gid)) {
    styleRuntimeStores.groups.set(gid, createJsonHotStore(path.join(STYLE_GROUP_DIR, `${encodeURIComponent(gid)}.json`), {
      fallback: () => ({
        version: 1,
        profile: defaultProfile(),
        samples: []
      })
    }));
  }
  return styleRuntimeStores.groups.get(gid);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeText(value, maxChars = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function normalizeId(value) {
  return normalizeText(value, 80);
}

function clampNumber(value, min, max, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function makeSampleId(entry = {}) {
  const messageId = normalizeId(entry.messageId || entry.message_id);
  if (messageId) return `msg:${messageId}`;
  const senderId = normalizeId(entry.senderId || entry.sender_id || 'unknown');
  const timestamp = Number(entry.timestamp || 0) || 0;
  const text = normalizeText(entry.text || '', 120);
  return `${senderId}:${timestamp}:${text}`;
}

function normalizeSample(entry = {}, kind = 'bot') {
  const text = normalizeText(entry.text || '', 240);
  const senderId = normalizeId(entry.senderId || entry.sender_id || (kind === 'bot' ? config.BOT_QQ || 'bot' : ''));
  const senderName = normalizeText(entry.senderName || entry.sender_name || '', 80);
  const groupId = normalizeId(entry.groupId || entry.group_id || '');
  const timestamp = Math.max(0, Number(entry.timestamp || nowMs()) || nowMs());
  return {
    id: makeSampleId({ ...entry, text }),
    kind: kind === 'human' ? 'human' : 'bot',
    text,
    senderId,
    senderName,
    groupId,
    timestamp
  };
}

function defaultProfile() {
  return {
    toneTags: [],
    sentenceLength: '',
    rhetoricalQuestionRatio: 0,
    memeCueRatio: 0,
    teaseCueRatio: 0,
    subjectOmissionRatio: 0,
    commonEndings: [],
    sampleCount: 0,
    updatedAt: 0
  };
}

function defaultStore() {
  return {
    version: 1,
    globalBotBase: {
      profile: defaultProfile(),
      samples: []
    },
    groupOverlays: {}
  };
}

function normalizeProfile(profile = {}) {
  const raw = profile && typeof profile === 'object' ? profile : {};
  return {
    toneTags: normalizeArray(raw.toneTags).map((item) => normalizeText(item, 24)).filter(Boolean).slice(0, 4),
    sentenceLength: normalizeText(raw.sentenceLength, 16),
    rhetoricalQuestionRatio: clampNumber(raw.rhetoricalQuestionRatio, 0, 1, 0),
    memeCueRatio: clampNumber(raw.memeCueRatio, 0, 1, 0),
    teaseCueRatio: clampNumber(raw.teaseCueRatio, 0, 1, 0),
    subjectOmissionRatio: clampNumber(raw.subjectOmissionRatio, 0, 1, 0),
    commonEndings: normalizeArray(raw.commonEndings).map((item) => normalizeText(item, 6)).filter(Boolean).slice(0, MAX_COMMON_ENDINGS),
    sampleCount: Math.max(0, Number(raw.sampleCount || 0) || 0),
    updatedAt: Math.max(0, Number(raw.updatedAt || 0) || 0)
  };
}

function normalizeSamples(samples = []) {
  const seen = new Set();
  const out = [];
  for (const item of normalizeArray(samples)) {
    const sample = normalizeSample(item, item?.kind === 'human' ? 'human' : 'bot');
    if (!sample.text) continue;
    if (seen.has(sample.id)) continue;
    seen.add(sample.id);
    out.push(sample);
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

function normalizeStore(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const groups = raw.groupOverlays && typeof raw.groupOverlays === 'object' ? raw.groupOverlays : {};
  const normalizedGroups = {};
  for (const [groupId, item] of Object.entries(groups)) {
    normalizedGroups[String(groupId)] = {
      profile: normalizeProfile(item?.profile),
      samples: normalizeSamples(item?.samples)
    };
  }
  return {
    version: 1,
    globalBotBase: {
      profile: normalizeProfile(raw.globalBotBase?.profile),
      samples: normalizeSamples(raw.globalBotBase?.samples)
    },
    groupOverlays: normalizedGroups
  };
}

function readStore() {
  ensureDir(STORE_FILE);
  const globalState = getGlobalStore().read();
  const legacy = normalizeStore(getLegacyStore().read());
  const mergedGroups = {};
  for (const [groupId, value] of Object.entries(legacy.groupOverlays || {})) {
    const groupStore = getGroupStore(groupId);
    if (!groupStore) continue;
    const fromGroupFile = groupStore.read();
    const normalized = normalizeStore({
      groupOverlays: {
        [groupId]: fromGroupFile
      }
    }).groupOverlays[groupId];
    mergedGroups[groupId] = normalized || value;
  }
  return normalizeStore({
    version: 1,
    globalBotBase: globalState,
    groupOverlays: mergedGroups
  });
}

function writeStore(store) {
  const normalized = normalizeStore(store);
  getGlobalStore().replace({
    version: 1,
    profile: normalized.globalBotBase.profile,
    samples: normalized.globalBotBase.samples
  });
  for (const [groupId, entry] of Object.entries(normalized.groupOverlays || {})) {
    const groupStore = getGroupStore(groupId);
    if (!groupStore) continue;
    groupStore.replace({
      version: 1,
      profile: entry.profile,
      samples: entry.samples
    });
  }
  getLegacyStore().replace(normalized);
}

function pruneSamples(samples = [], { cutoffMs = 0, limit = 100 } = {}) {
  const cutoff = cutoffMs > 0 ? nowMs() - cutoffMs : 0;
  const filtered = normalizeSamples(samples).filter((item) => !cutoff || item.timestamp >= cutoff);
  if (filtered.length <= limit) return filtered;
  return filtered.slice(filtered.length - limit);
}

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

function ensureGroupEntry(store, groupId) {
  const gid = normalizeId(groupId);
  if (!gid) return null;
  if (!store.groupOverlays[gid]) {
    store.groupOverlays[gid] = {
      profile: defaultProfile(),
      samples: []
    };
  }
  return store.groupOverlays[gid];
}

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

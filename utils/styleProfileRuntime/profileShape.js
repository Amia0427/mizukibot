const config = require('../../config');
const {
  MAX_COMMON_ENDINGS,
  clampNumber,
  normalizeArray,
  normalizeId,
  normalizeText,
  nowMs
} = require('./common');

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

function pruneSamples(samples = [], { cutoffMs = 0, limit = 100 } = {}) {
  const cutoff = cutoffMs > 0 ? nowMs() - cutoffMs : 0;
  const filtered = normalizeSamples(samples).filter((item) => !cutoff || item.timestamp >= cutoff);
  if (filtered.length <= limit) return filtered;
  return filtered.slice(filtered.length - limit);
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

module.exports = {
  defaultProfile,
  defaultStore,
  ensureGroupEntry,
  makeSampleId,
  normalizeProfile,
  normalizeSample,
  normalizeSamples,
  normalizeStore,
  pruneSamples
};

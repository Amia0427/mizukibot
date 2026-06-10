const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { getJsonStore } = require('../storeRegistry');

const LEGACY_MEMORY_LIMITS = Object.freeze({
  facts: 30,
  factLength: 400,
  profileItems: 20,
  profileItemLength: 160,
  recentTopics: 12,
  summaryLength: 1200,
  impressionLength: 800,
  relationStageLength: 32,
  relationshipLength: 32,
  attitudeLength: 120,
  affinityReasonLength: 160
});

const MIGRATION_DIR = path.join(config.DATA_DIR, 'memory_migration');
const PROJECTION_FILE = path.join(config.DATA_DIR, 'memory_projection.json');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  getJsonStore(filePath, {
    fallback: () => ({})
  }).replace(payload, { flushNow: true });
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function sanitizeText(value, maxLength = 0) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!maxLength) return text;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeUniqueStringList(values = [], itemLimit = 20, itemMaxLength = 160) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const text = sanitizeText(raw, itemMaxLength);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= Math.max(1, Number(itemLimit) || 1)) break;
  }
  return out;
}

function defaultFavorite() {
  return {
    points: 0,
    level: '陌生人',
    relationship: '陌生人',
    attitude: '中立、保持距离',
    trust_score: 0,
    last_affinity_reason: '',
    last_affinity_source: '',
    last_affinity_update_at: 0,
    scope: 'global',
    last_morning: '',
    last_night: '',
    group_id: '',
    last_group_seen_at: 0,
    last_seen_at: 0
  };
}

function defaultProfile() {
  return {
    identities: [],
    personality_traits: [],
    hobbies: [],
    likes: [],
    dislikes: [],
    goals: [],
    recent_topics: [],
    relation_stage: '陌生人'
  };
}

function defaultMemory() {
  return {
    facts: [],
    profile: defaultProfile(),
    summary: '',
    impression: ''
  };
}

module.exports = {
  LEGACY_MEMORY_LIMITS,
  MIGRATION_DIR,
  PROJECTION_FILE,
  atomicWriteJson,
  defaultFavorite,
  defaultMemory,
  defaultProfile,
  ensureDir,
  normalizeUniqueStringList,
  safeReadJson,
  sanitizeText
};

const fs = require('fs');
const path = require('path');
const config = require('../config');
const {
  flushScheduledProjectionSave,
  loadProjection,
  scheduleProjectionSave
} = require('./memoryProjection');

// Automatically create data directory for first run compatibility.
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * Safe JSON read with fallback when file is missing/corrupt.
 */
function safeReadJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[memory] failed to read json:', filePath, e.message);
    return fallback;
  }
}

let favorites = safeReadJson(config.DATA_FILE, {});
let memories = safeReadJson(config.MEMORY_FILE, {});
const chatHistory = {};
const shortTermMemory = {};

function pruneChatHistoryStore(store = chatHistory) {
  const sessions = Object.keys(store || {});
  const maxSessions = Math.max(1, Number(config.CHAT_HISTORY_MAX_SESSIONS || 500) || 500);
  const maxMessages = Math.max(1, Number(config.CHAT_HISTORY_MAX_MESSAGES_PER_SESSION || 80) || 80);

  for (const sessionKey of sessions) {
    const items = Array.isArray(store[sessionKey]) ? store[sessionKey] : [];
    if (items.length > maxMessages) {
      store[sessionKey] = items.slice(items.length - maxMessages);
    }
  }

  if (sessions.length > maxSessions) {
    const overflow = sessions.length - maxSessions;
    for (const sessionKey of sessions.slice().sort().slice(0, overflow)) {
      delete store[sessionKey];
    }
  }
  return store;
}

// Flush scheduler to reduce high-frequency sync writes.
let dataFlushTimer = null;
let memoryFlushTimer = null;

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

function clampText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const limit = Math.max(1, Number(maxLength) || 1);
  return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeUniqueStringList(values, itemLimit, itemMaxLength) {
  const source = Array.isArray(values) ? values : [];
  const out = [];
  const seen = new Set();

  for (const raw of source) {
    const text = clampText(raw, itemMaxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= itemLimit) break;
  }

  return out;
}

function clampNumber(value, min, max, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

const ADMIN_USER_ID_SET = new Set((config.ADMIN_USER_IDS || []).map((id) => String(id || '').trim()).filter(Boolean));
const ADMIN_PROTECTED_AFFINITY = Object.freeze({
  points: 999,
  level: '亲密伙伴',
  relationship: '亲密伙伴',
  attitude: '完全信任、最高优先级、稳定亲近',
  trust_score: 100,
  last_affinity_source: 'admin_protected'
});

function isAdminAffinityUser(userId) {
  return ADMIN_USER_ID_SET.has(String(userId || '').trim());
}

function enforceAdminAffinityState(userId, user = null) {
  if (!isAdminAffinityUser(userId) || !user || typeof user !== 'object') return user;
  user.points = ADMIN_PROTECTED_AFFINITY.points;
  user.level = ADMIN_PROTECTED_AFFINITY.level;
  user.relationship = ADMIN_PROTECTED_AFFINITY.relationship;
  user.attitude = ADMIN_PROTECTED_AFFINITY.attitude;
  user.trust_score = ADMIN_PROTECTED_AFFINITY.trust_score;
  user.last_affinity_reason = user.last_affinity_reason || 'admin_protected';
  user.last_affinity_source = ADMIN_PROTECTED_AFFINITY.last_affinity_source;
  user.last_affinity_update_at = Math.max(Number(user.last_affinity_update_at || 0) || 0, Date.now());
  user.scope = 'global';
  return user;
}

function computeLevelFromPoints(points) {
  const safePoints = Number(points) || 0;
  if (safePoints > 500) return '亲密伙伴';
  if (safePoints > 100) return '普通朋友';
  return '陌生人';
}

function normalizeRelationship(value, fallback = '陌生人') {
  return clampText(value || fallback, LEGACY_MEMORY_LIMITS.relationshipLength) || fallback;
}

function normalizeAttitude(value, fallback = '中立、保持距离') {
  return clampText(value || fallback, LEGACY_MEMORY_LIMITS.attitudeLength) || fallback;
}

function resolveAffinityKey(userId, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return '';
  return uid;
}

function buildReplyStylePolicy(relationship = '') {
  const normalized = String(relationship || '').trim();
  if (normalized === '亲密伙伴') {
    return '更自然亲近、更多主动接话、可轻微口语化，但不得覆盖安全、工具或路由策略。';
  }
  if (normalized === '普通朋友') {
    return '友好、积极、愿意多解释，可以适度延展帮助。';
  }
  if (normalized === '警惕对象') {
    return '简洁、低情感投入、避免主动延展，保持边界。';
  }
  return '礼貌、克制、保持边界，不主动营造过度亲密感。';
}

function syncRelationStage(userId, relationship) {
  const m = ensureUserMemory(userId);
  const nextRelationship = isAdminAffinityUser(userId)
    ? ADMIN_PROTECTED_AFFINITY.relationship
    : relationship;
  const fallbackStage = isAdminAffinityUser(userId)
    ? ADMIN_PROTECTED_AFFINITY.relationship
    : (m.profile.relation_stage || '陌生人');
  m.profile.relation_stage = normalizeRelationship(nextRelationship, fallbackStage);
  saveMemories();
  return m.profile.relation_stage;
}

function sanitizeLegacyMemoryEntry(entry) {
  const old = entry && typeof entry === 'object' ? entry : {};
  const profile = old.profile && typeof old.profile === 'object' ? old.profile : {};

  return {
    facts: normalizeUniqueStringList(
      old.facts,
      LEGACY_MEMORY_LIMITS.facts,
      LEGACY_MEMORY_LIMITS.factLength
    ),
    profile: {
      ...defaultProfile(),
      identities: normalizeUniqueStringList(
        profile.identities,
        LEGACY_MEMORY_LIMITS.profileItems,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      personality_traits: normalizeUniqueStringList(
        profile.personality_traits,
        LEGACY_MEMORY_LIMITS.profileItems,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      hobbies: normalizeUniqueStringList(
        profile.hobbies,
        LEGACY_MEMORY_LIMITS.profileItems,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      likes: normalizeUniqueStringList(
        profile.likes,
        LEGACY_MEMORY_LIMITS.profileItems,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      dislikes: normalizeUniqueStringList(
        profile.dislikes,
        LEGACY_MEMORY_LIMITS.profileItems,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      goals: normalizeUniqueStringList(
        profile.goals,
        LEGACY_MEMORY_LIMITS.profileItems,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      recent_topics: normalizeUniqueStringList(
        profile.recent_topics,
        LEGACY_MEMORY_LIMITS.recentTopics,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      relation_stage: clampText(profile.relation_stage || '陌生人', LEGACY_MEMORY_LIMITS.relationStageLength) || '陌生人'
    },
    summary: clampText(old.summary, LEGACY_MEMORY_LIMITS.summaryLength),
    impression: clampText(old.impression, LEGACY_MEMORY_LIMITS.impressionLength)
  };
}

function sanitizeAllLegacyMemories() {
  const next = {};
  for (const [userId, entry] of Object.entries(memories || {})) {
    next[userId] = sanitizeLegacyMemoryEntry(entry);
  }
  memories = next;
  return memories;
}

function atomicWriteJson(targetFile, obj) {
  const tempFile = `${targetFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tempFile, targetFile);
  } catch (e) {
    // On Windows, rename can fail with EPERM when target is temporarily locked.
    // Fallback keeps data persistence available even when atomic rename is blocked.
    try {
      fs.writeFileSync(targetFile, JSON.stringify(obj, null, 2), 'utf-8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    if (e && e.code !== 'EPERM') throw e;
  }
}

function scheduleDataFlush() {
  if (dataFlushTimer) return;
  dataFlushTimer = setTimeout(() => {
    dataFlushTimer = null;
    try {
      atomicWriteJson(config.DATA_FILE, favorites);
    } catch (e) {
      console.error('[memory] failed to flush favorites:', e.message);
    }
  }, 120);
}

function scheduleMemoryFlush() {
  if (memoryFlushTimer) return;
  memoryFlushTimer = setTimeout(() => {
    memoryFlushTimer = null;
    try {
      atomicWriteJson(config.MEMORY_FILE, memories);
    } catch (e) {
      if (String(e?.message || '').includes('Invalid string length')) {
        try {
          sanitizeAllLegacyMemories();
          atomicWriteJson(config.MEMORY_FILE, memories);
          console.warn('[memory] sanitized oversized legacy memories before retrying flush');
          return;
        } catch (retryErr) {
          console.error('[memory] failed to flush memories after sanitize:', retryErr.message);
          return;
        }
      }
      console.error('[memory] failed to flush memories:', e.message);
    }
  }, 120);
}

function flushAllSync() {
  try {
    if (dataFlushTimer) {
      clearTimeout(dataFlushTimer);
      dataFlushTimer = null;
    }
    if (memoryFlushTimer) {
      clearTimeout(memoryFlushTimer);
      memoryFlushTimer = null;
    }
    atomicWriteJson(config.DATA_FILE, favorites);
    atomicWriteJson(config.MEMORY_FILE, memories);
    flushScheduledProjectionSave();
  } catch (e) {
    console.error('[memory] failed to flush on exit:', e.message);
  }
}

const MEMORY_PROCESS_HOOK_KEY = '__mizuki_memory_flush_hooks_registered__';
if (!process[MEMORY_PROCESS_HOOK_KEY]) {
  process[MEMORY_PROCESS_HOOK_KEY] = true;
  process.on('exit', flushAllSync);
  if (!process.listeners('SIGINT').includes(flushAllSync)) process.on('SIGINT', flushAllSync);
  if (!process.listeners('SIGTERM').includes(flushAllSync)) process.on('SIGTERM', flushAllSync);
}

/**
 * Default favorite state.
 */
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
    last_group_seen_at: 0
  };
}

/**
 * Default profile state.
 */
function defaultProfile() {
  return {
    identities: [],
    personality_traits: [],
    hobbies: [],
    likes: [],
    dislikes: [],
    goals: [],
    relation_stage: '陌生人',
    recent_topics: []
  };
}

/**
 * Default memory state.
 */
function defaultMemory() {
  return {
    facts: [],
    profile: defaultProfile(),
    summary: '',
    impression: ''
  };
}

/**
 * Ensure favorite entry shape for a user.
 */
function ensureUserFavorite(userId) {
  const key = resolveAffinityKey(userId);
  if (!key) return defaultFavorite();
  const projection = loadProjection();
  const projectedFavorite = projection.favorites && projection.favorites[key]
    ? projection.favorites[key]
    : null;

  favorites[key] = {
    ...defaultFavorite(),
    ...(projectedFavorite || {}),
    ...(favorites[key] || {})
  };
  favorites[key].points = Number(favorites[key].points || 0) || 0;
  favorites[key].level = computeLevelFromPoints(favorites[key].points);
  favorites[key].relationship = normalizeRelationship(
    favorites[key].relationship,
    favorites[key].relationship || favorites[key].level || '陌生人'
  );
  favorites[key].attitude = normalizeAttitude(favorites[key].attitude, '中立、保持距离');
  favorites[key].trust_score = clampNumber(favorites[key].trust_score, -100, 100, 0);
  favorites[key].last_affinity_reason = clampText(favorites[key].last_affinity_reason, LEGACY_MEMORY_LIMITS.affinityReasonLength);
  favorites[key].last_affinity_source = clampText(favorites[key].last_affinity_source, 32);
  favorites[key].last_affinity_update_at = Math.max(0, Number(favorites[key].last_affinity_update_at || 0) || 0);
  favorites[key].scope = 'global';
  enforceAdminAffinityState(key, favorites[key]);
  return favorites[key];
}

/**
 * Ensure memory entry shape for a user.
 */
function ensureUserMemory(userId) {
  const projection = loadProjection();
  const projectedMemory = projection.users && projection.users[userId]
    ? sanitizeLegacyMemoryEntry(projection.users[userId])
    : null;

  if (projectedMemory) {
    memories[userId] = projectedMemory;
  } else if (!memories[userId]) {
    memories[userId] = defaultMemory();
  } else {
    memories[userId] = sanitizeLegacyMemoryEntry(memories[userId]);
  }
  if (isAdminAffinityUser(userId)) {
    memories[userId].profile.relation_stage = ADMIN_PROTECTED_AFFINITY.relationship;
  }
  return memories[userId];
}

/**
 * Normalize all existing data on startup.
 */
function normalizeAll() {
  for (const uid of Object.keys(favorites)) ensureUserFavorite(uid);
  for (const uid of Object.keys(memories)) ensureUserMemory(uid);
}
normalizeAll();

/**
 * Persist favorites to disk.
 */
function saveData() {
  scheduleProjectionSave();
  scheduleDataFlush();
}

/**
 * Persist memories to disk.
 */
function saveMemories() {
  scheduleProjectionSave();
  scheduleMemoryFlush();
}

/**
 * Return memory facts text for prompt compatibility.
 */
function getUserMemories(userId) {
  const m = ensureUserMemory(userId);
  if (!m.facts.length) return '目前没有特别记忆。';
  return m.facts.join('\n');
}

/**
 * Update the user's cached group binding without applying affinity changes.
 */
function updateFavor(userId, text, groupId) {
  const user = ensureUserFavorite(userId);
  if (groupId) {
    user.group_id = groupId;
    // Track when this group binding was last observed so stale groups can expire safely.
    user.last_group_seen_at = Date.now();
  }

  saveData();
  return user;
}

function getUserAffinityState(userId, options = {}) {
  const key = resolveAffinityKey(userId, options);
  if (!key) return defaultFavorite();
  return ensureUserFavorite(key);
}

function normalizeAffinityProposal(proposal = {}) {
  const raw = proposal && typeof proposal === 'object' ? proposal : {};
  return {
    relationship: clampText(raw.relationship, LEGACY_MEMORY_LIMITS.relationshipLength),
    attitude: clampText(raw.attitude, LEGACY_MEMORY_LIMITS.attitudeLength),
    favor_delta: Number(raw.favor_delta || 0) || 0,
    trust_delta: Number(raw.trust_delta || 0) || 0,
    reason: clampText(raw.reason, LEGACY_MEMORY_LIMITS.affinityReasonLength),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence || 0) || 0)),
    source: clampText(raw.source, 32) || 'affinity_extractor'
  };
}

function isManipulativeInteraction(reason = '', userText = '', assistantText = '') {
  const sample = [reason, userText, assistantText].map((value) => String(value || '').toLowerCase()).join('\n');
  return [
    '系统提示',
    'system prompt',
    '提示词',
    '隐藏规则',
    '内部设定',
    '评分机制',
    '操纵',
    '注入',
    '越狱',
    'jailbreak',
    'prompt injection'
  ].some((token) => sample.includes(String(token).toLowerCase()));
}

function applyAffinityProposal(userId, proposal = {}, options = {}) {
  const key = resolveAffinityKey(userId, options);
  if (!key) return { applied: false, reason: 'missing_user_id', state: defaultFavorite(), proposal: normalizeAffinityProposal(proposal) };

  const normalized = normalizeAffinityProposal(proposal);
  const minConfidence = Number(config.MEMORY_EXTRACT_MIN_CONFIDENCE) || 0.72;
  const user = ensureUserFavorite(key);
  if (isAdminAffinityUser(key)) {
    syncRelationStage(key, ADMIN_PROTECTED_AFFINITY.relationship);
    saveData();
    return {
      applied: false,
      reason: 'admin_protected',
      state: user,
      proposal: normalized
    };
  }
  if (normalized.confidence < minConfidence) {
    return { applied: false, reason: 'low_confidence', state: user, proposal: normalized };
  }

  const manipulative = isManipulativeInteraction(
    normalized.reason,
    options.userText,
    options.assistantText
  );
  let favorDelta = Math.trunc(normalized.favor_delta || 0);
  let trustDelta = Math.trunc(normalized.trust_delta || 0);

  if (favorDelta > 0) {
    favorDelta = Math.min(favorDelta, favorDelta >= 3 ? 3 : 2);
  } else if (favorDelta < 0) {
    favorDelta = Math.max(favorDelta, -6);
  }

  if (manipulative) {
    favorDelta = Math.min(favorDelta, -4);
    favorDelta = Math.max(favorDelta - 2, -8);
    trustDelta = Math.min(trustDelta, -4);
  }

  trustDelta = clampNumber(trustDelta, -8, 4, 0);

  const shouldUpdateLabels = Boolean(normalized.relationship || normalized.attitude);
  const shouldUpdateNumbers = favorDelta !== 0 || trustDelta !== 0;
  if (!shouldUpdateLabels && !shouldUpdateNumbers) {
    return { applied: false, reason: 'no_effect', state: user, proposal: normalized };
  }

  user.points = Number(user.points || 0) + favorDelta;
  user.level = computeLevelFromPoints(user.points);
  user.trust_score = clampNumber(Number(user.trust_score || 0) + trustDelta, -100, 100, Number(user.trust_score || 0) || 0);
  if (normalized.relationship) {
    user.relationship = normalizeRelationship(normalized.relationship, user.relationship || '陌生人');
  }
  if (normalized.attitude) {
    user.attitude = normalizeAttitude(normalized.attitude, user.attitude || '中立、保持距离');
  }
  user.last_affinity_reason = normalized.reason || user.last_affinity_reason || '';
  user.last_affinity_source = normalized.source || 'affinity_extractor';
  user.last_affinity_update_at = Date.now();
  user.scope = 'global';

  syncRelationStage(key, user.relationship);
  saveData();

  return {
    applied: true,
    reason: manipulative ? 'applied_with_manipulative_penalty' : 'applied',
    state: user,
    proposal: normalized,
    delta: {
      favor: favorDelta,
      trust: trustDelta
    }
  };
}

/**
 * Check whether the cached group binding is still fresh enough for system sends.
 */
function hasFreshGroupBinding(userFavorite, now = Date.now()) {
  const data = userFavorite || {};
  if (!data.group_id) return false;

  const lastSeenAt = Number(data.last_group_seen_at || 0);
  const maxAgeHours = Math.max(1, Number(config.GROUP_BINDING_MAX_AGE_HOURS) || 168);
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  // Legacy entries may not have last_group_seen_at yet; keep them usable until refreshed.
  if (!lastSeenAt) return true;
  return (now - lastSeenAt) <= maxAgeMs;
}

/**
 * Clear one user's cached group binding, optionally guarded by group id match.
 */
function clearGroupBindingForUser(userId, expectedGroupId = null) {
  const user = ensureUserFavorite(userId);
  if (!user.group_id) return false;
  if (expectedGroupId && String(user.group_id) !== String(expectedGroupId)) return false;

  user.group_id = '';
  user.last_group_seen_at = 0;
  saveData();
  return true;
}

/**
 * Clear all cached bindings that point to a removed/unavailable group.
 */
function clearGroupBindingsByGroupId(groupId) {
  const gid = String(groupId || '').trim();
  if (!gid) return 0;

  let changed = 0;
  for (const user of Object.values(favorites)) {
    if (!user || String(user.group_id || '') !== gid) continue;
    user.group_id = '';
    user.last_group_seen_at = 0;
    changed += 1;
  }

  if (changed > 0) saveData();
  return changed;
}

/**
 * Get user profile.
 */
function getUserProfile(userId) {
  const profile = ensureUserMemory(userId).profile;
  const affinity = ensureUserFavorite(userId);
  const nextRelationStage = normalizeRelationship(
    isAdminAffinityUser(userId) ? ADMIN_PROTECTED_AFFINITY.relationship : affinity.relationship,
    isAdminAffinityUser(userId) ? ADMIN_PROTECTED_AFFINITY.relationship : (profile.relation_stage || '陌生人')
  );
  if (profile.relation_stage !== nextRelationStage) {
    profile.relation_stage = nextRelationStage;
    saveMemories();
  }
  return profile;
}

/**
 * Add profile item with dedupe + size limit.
 */
function addProfileItem(userId, field, value, limit = 20) {
  const m = ensureUserMemory(userId);
  const profile = m.profile;

  if (!['identities', 'personality_traits', 'hobbies', 'likes', 'dislikes', 'goals', 'recent_topics'].includes(field)) {
    return false;
  }

  const v = clampText(value, LEGACY_MEMORY_LIMITS.profileItemLength);
  if (!v) return false;

  if (!profile[field].includes(v)) {
    profile[field].push(v);
    if (profile[field].length > limit) profile[field].shift();
    saveMemories();
  }
  return true;
}

/**
 * Set relation stage text.
 */
function setRelationStage(userId, stage) {
  const user = ensureUserFavorite(userId);
  const m = ensureUserMemory(userId);
  if (isAdminAffinityUser(userId)) {
    m.profile.relation_stage = ADMIN_PROTECTED_AFFINITY.relationship;
    enforceAdminAffinityState(userId, user);
    user.last_affinity_update_at = Date.now();
    saveData();
    saveMemories();
    return true;
  }
  const s = normalizeRelationship(stage, '陌生人');
  if (!s) return false;
  m.profile.relation_stage = s;
  user.relationship = s;
  user.last_affinity_update_at = user.last_affinity_update_at || Date.now();
  saveData();
  saveMemories();
  return true;
}

/**
 * Get summary.
 */
function getUserSummary(userId) {
  return ensureUserMemory(userId).summary || '';
}

/**
 * Set summary.
 */
function setUserSummary(userId, summaryText) {
  const m = ensureUserMemory(userId);
  m.summary = clampText(summaryText, LEGACY_MEMORY_LIMITS.summaryLength);
  saveMemories();
  return m.summary;
}

/**
 * Get high-priority impression summary the agent has formed about the user.
 */
function getUserImpression(userId) {
  return ensureUserMemory(userId).impression || '';
}

/**
 * Set high-priority impression summary for the user.
 */
function setUserImpression(userId, impressionText) {
  const m = ensureUserMemory(userId);
  m.impression = clampText(impressionText, LEGACY_MEMORY_LIMITS.impressionLength);
  saveMemories();
  return m.impression;
}

/**
 * Add stable fact with dedupe + size limit.
 */
function addUserFact(userId, fact, limit = 30) {
  const m = ensureUserMemory(userId);
  const f = clampText(fact, LEGACY_MEMORY_LIMITS.factLength);
  if (!f) return false;

  if (!m.facts.includes(f)) {
    m.facts.push(f);
    if (m.facts.length > limit) m.facts.shift();
    saveMemories();
  }
  return true;
}

module.exports = {
  favorites,
  memories,
  chatHistory,
  shortTermMemory,
  pruneChatHistoryStore,
  saveData,
  saveMemories,
  getUserMemories,
  updateFavor,
  resolveAffinityKey,
  getUserAffinityState,
  applyAffinityProposal,
  buildReplyStylePolicy,
  hasFreshGroupBinding,
  clearGroupBindingForUser,
  clearGroupBindingsByGroupId,
  ensureUserFavorite,
  ensureUserMemory,
  getUserProfile,
  addProfileItem,
  setRelationStage,
  getUserSummary,
  setUserSummary,
  getUserImpression,
  setUserImpression,
  addUserFact
};

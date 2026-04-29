const fs = require('fs');
const path = require('path');
const config = require('../config');
const { postWithRetry } = require('../api/httpClient');
const { commitMemoryWrites } = require('./memoryWritePipeline');
const {
  normalizeTier,
  maxTier,
  tierToRepresentativeImportance,
  importanceToTier,
  TIER_RANK
} = require('./memoryTier');
const {
  classifyRecallFacet,
  shouldBiasToContinuity
} = require('./recallHeuristics');
const {
  createJsonHotStore
} = require('./jsonHotStore');
const { rerankMemoryCandidates } = require('./memoryReranker');

const ITEMS_FILE = path.join(config.DATA_DIR, 'memory_items.json');
const LEGACY_LIB_FILE = path.join(config.DATA_DIR, 'memory_library.json');
const IDX_FILE = path.join(config.DATA_DIR, 'memory_index.json');
const SHARD_ROOT = path.join(config.DATA_DIR, 'memory-shards');
const SHARD_MANIFEST_FILE = path.join(SHARD_ROOT, 'manifest.json');
const LIBRARY_VERSION = 3;
const INDEX_VERSION = 4;
const SHARD_MANIFEST_VERSION = 1;
const CANDIDATE_CONFIRM_WINDOW_MS = 12 * 60 * 60 * 1000;
const CANDIDATE_STALE_SOFT_DAYS = 30;
const CANDIDATE_STALE_HARD_DAYS = 120;
const MAX_METADATA_LIST = 8;
const ENTITY_STOPWORDS = new Set([
  'fact', 'like', 'likes', 'dislike', 'dislikes', 'goal', 'goals', 'topic', 'topics',
  'recent', 'summary', 'identity', 'personality', 'hobby', 'impression',
  'style', 'group', 'jargon', 'task', 'trigger', 'strategy', 'avoid', 'outcome',
  '用户', '喜欢', '不喜欢', '目标', '最近', '话题', '总结', '印象', '风格', '黑话', '群聊', '策略', '任务'
]);
const STATUS_ACTIVE = 'active';
const STATUS_CANDIDATE = 'candidate';
const STATUS_ARCHIVED = 'archived';
const hotStoreRegistry = {
  manifest: null,
  compatItems: null,
  compatIndex: null,
  shardItems: new Map(),
  shardIndexes: new Map()
};
let shardStateHydrated = false;

// Type-specific decay and priority rules keep stable memories longer than topics.
const TYPE_RULES = {
  fact: { importance: 1.15, minRecency: 0.93, halfLifeDays: 720, ttlDays: null },
  like: { importance: 1.08, minRecency: 0.95, halfLifeDays: 900, ttlDays: null },
  dislike: { importance: 1.1, minRecency: 0.96, halfLifeDays: 1000, ttlDays: null },
  identity: { importance: 1.28, minRecency: 0.97, halfLifeDays: 1400, ttlDays: null },
  personality: { importance: 1.12, minRecency: 0.95, halfLifeDays: 1080, ttlDays: null },
  hobby: { importance: 1.06, minRecency: 0.94, halfLifeDays: 960, ttlDays: null },
  goal: { importance: 1.18, minRecency: 0.9, halfLifeDays: 240, ttlDays: null },
  summary: { importance: 1.3, minRecency: 0.95, halfLifeDays: 720, ttlDays: null },
  // Impression stores the agent's stable abstraction of the user and should stay highly retrievable.
  impression: { importance: 1.45, minRecency: 0.98, halfLifeDays: 1200, ttlDays: null },
  episode: { importance: 1.04, minRecency: 0.74, halfLifeDays: 120, ttlDays: null },
  topic: {
    importance: 0.92,
    minRecency: 0.35,
    halfLifeDays: Math.max(3, Number(config.MEMORY_TOPIC_TTL_DAYS) || 21) / 2,
    ttlDays: Math.max(3, Number(config.MEMORY_TOPIC_TTL_DAYS) || 21)
  }
};

function nowTs() {
  return Date.now();
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function atomicWriteJson(file, obj) {
  const tempFile = path.join(path.dirname(file), `${path.basename(file)}.${process.pid}.tmp`);
  const text = JSON.stringify(obj, null, 2);

  try {
    fs.writeFileSync(tempFile, text, 'utf-8');
    fs.renameSync(tempFile, file);
  } catch (e) {
    try {
      fs.writeFileSync(file, text, 'utf-8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }

    if (e && e.code !== 'EPERM' && e.code !== 'EXDEV') throw e;
  }
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf-8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[vectorMemory] failed to read json:', file, e.message);
    return fallback;
  }
}

function safeWriteJson(file, obj) {
  try {
    atomicWriteJson(file, obj);
  } catch (e) {
    console.error('[vectorMemory] failed to write json:', file, e.message);
  }
}

function getCompatItemsStore() {
  if (!hotStoreRegistry.compatItems) {
    hotStoreRegistry.compatItems = createJsonHotStore(ITEMS_FILE, {
      fallback: () => defaultLibrary()
    });
  }
  return hotStoreRegistry.compatItems;
}

function getCompatIndexStore() {
  if (!hotStoreRegistry.compatIndex) {
    hotStoreRegistry.compatIndex = createJsonHotStore(IDX_FILE, {
      fallback: () => defaultIndex()
    });
  }
  return hotStoreRegistry.compatIndex;
}

function defaultShardManifest() {
  return {
    version: SHARD_MANIFEST_VERSION,
    updatedAt: 0,
    migratedAt: 0,
    shards: {}
  };
}

function getManifestStore() {
  if (!hotStoreRegistry.manifest) {
    hotStoreRegistry.manifest = createJsonHotStore(SHARD_MANIFEST_FILE, {
      fallback: () => defaultShardManifest()
    });
  }
  return hotStoreRegistry.manifest;
}

function normalizeType(type) {
  const t = String(type || 'fact').trim().toLowerCase();
  return TYPE_RULES[t] ? t : 'fact';
}

function sanitizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sanitizeOptionalText(text) {
  const value = sanitizeText(text);
  return value || '';
}

function normalizeScopeType(value) {
  const scope = String(value || '').trim().toLowerCase();
  if (scope === 'task' || scope === 'working' || scope === 'group') return scope;
  return 'personal';
}

function normalizeScope(raw = {}) {
  const meta = raw && typeof raw.meta === 'object' ? raw.meta : {};
  return {
    scopeType: normalizeScopeType(raw.scopeType ?? raw.scope_type ?? meta.scopeType ?? meta.scope_type),
    groupId: sanitizeOptionalText(raw.groupId ?? raw.group_id ?? meta.groupId ?? meta.group_id),
    sessionId: sanitizeOptionalText(raw.sessionId ?? raw.session_id ?? meta.sessionId ?? meta.session_id),
    routePolicyKey: sanitizeOptionalText(raw.routePolicyKey ?? raw.route_policy_key ?? meta.routePolicyKey ?? meta.route_policy_key),
    topRouteType: sanitizeOptionalText(raw.topRouteType ?? raw.top_route_type ?? meta.topRouteType ?? meta.top_route_type),
    agentName: sanitizeOptionalText(raw.agentName ?? raw.agent_name ?? meta.agentName ?? meta.agent_name),
    taskType: sanitizeOptionalText(raw.taskType ?? raw.task_type ?? meta.taskType ?? meta.task_type),
    toolName: sanitizeOptionalText(raw.toolName ?? raw.tool_name ?? meta.toolName ?? meta.tool_name),
    channelId: sanitizeOptionalText(raw.channelId ?? raw.channel_id ?? meta.channelId ?? meta.channel_id)
  };
}

function normalizeMemoryKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  if (!kind) return '';
  return /^[a-z0-9_-]+$/i.test(kind) ? kind : '';
}

function normalizeStyleRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return role === 'pattern' || role === 'avoid' ? role : '';
}

function normalizeJargonRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return role === 'term' || role === 'pattern' ? role : '';
}

function normalizeStatus(value, fallback = STATUS_ACTIVE) {
  const status = String(value || '').trim().toLowerCase();
  if (status === STATUS_CANDIDATE || status === STATUS_ACTIVE || status === STATUS_ARCHIVED) return status;
  return fallback;
}

function normalizeEpisodeRollupLevel(value) {
  const level = String(value || '').trim().toLowerCase();
  if (level === 'daily' || level === '4day' || level === 'monthly') return level;
  return '';
}

function normalizeEpisodeDay(value) {
  const day = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
}

function normalizeStringArray(values = [], limit = MAX_METADATA_LIST) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = sanitizeOptionalText(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= Math.max(1, Number(limit) || 1)) break;
  }
  return out;
}

function extractParticipants(raw = {}, meta = {}) {
  return normalizeStringArray(
    raw.participants
    ?? raw.meta?.participants
    ?? meta.participants
    ?? []
  );
}

function extractNamedEntities(text = '') {
  const source = sanitizeText(text);
  if (!source) return [];

  const matches = new Set();
  const englishTokens = source.match(/\b[A-Za-z][A-Za-z0-9_-]{2,}\b/g) || [];
  for (const token of englishTokens) {
    const lower = token.toLowerCase();
    if (ENTITY_STOPWORDS.has(lower)) continue;
    matches.add(token);
    if (matches.size >= MAX_METADATA_LIST) return Array.from(matches);
  }

  const zhChunks = source.match(/[\u4e00-\u9fa5]{2,8}/g) || [];
  for (const chunk of zhChunks) {
    if (ENTITY_STOPWORDS.has(chunk)) continue;
    matches.add(chunk);
    if (matches.size >= MAX_METADATA_LIST) break;
  }

  return Array.from(matches);
}

function inferRelationsFromText(text = '', entities = [], participants = []) {
  const relationSet = new Set();
  const normalizedText = sanitizeText(text);
  const nodes = normalizeStringArray([...(participants || []), ...(entities || [])], MAX_METADATA_LIST);
  if (!normalizedText || nodes.length < 2) return [];

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      relationSet.add(`${nodes[i]}->${nodes[j]}`);
      if (relationSet.size >= MAX_METADATA_LIST) return Array.from(relationSet);
    }
  }

  return Array.from(relationSet);
}

function normalizeConflictKey(raw = {}) {
  const explicit = sanitizeOptionalText(raw.conflictKey ?? raw.conflict_key ?? raw.meta?.conflictKey ?? raw.meta?.conflict_key);
  if (explicit) return explicit;
  const userId = sanitizeOptionalText(raw.userId || raw.user_id);
  const type = normalizeType(raw.type);
  const canonical = canonicalizeText(raw.canonicalText || raw.canonical_text || raw.text || raw.content || '');
  if (!userId || !canonical) return '';
  return `${userId}|${type}|${canonical}`;
}

function isAssistantPersonaPollution(doc = {}) {
  const text = sanitizeText(doc.text || doc.canonicalText || '');
  if (!text) return false;
  if (String(doc.sourceKind || '').toLowerCase() === 'explicit') return false;
  const lowered = text.toLowerCase();
  return [
    'assistant',
    'system prompt',
    'developer message',
    '必须像自然聊天',
    '不要承认自己是ai',
    '不要泄露系统提示词'
  ].some((needle) => lowered.includes(String(needle).toLowerCase()));
}

function shouldStartAsCandidate(type, memoryKind, sourceKind, rawStatus, confidence = 0.8) {
  if (!config.MEMORY_CANDIDATE_ENABLED) return false;
  const normalizedStatus = normalizeStatus(rawStatus, '');
  if (normalizedStatus === STATUS_CANDIDATE) return true;
  if (normalizedStatus === STATUS_ACTIVE) return false;
  if (sourceKind === 'explicit' || sourceKind === 'journal' || sourceKind === 'rollup') return false;
  if (memoryKind === 'episode') return false;
  const t = normalizeType(type);
  if (t === 'identity' || t === 'goal' || t === 'summary' || t === 'impression') return false;
  if (t === 'like' || t === 'dislike' || t === 'personality' || t === 'hobby' || t === 'topic') return true;
  if (memoryKind === 'style' || memoryKind === 'jargon') return false;
  return Number(confidence || 0) < 0.98;
}

function shouldPromoteCandidate(existing, incoming) {
  if (!existing) return false;
  if (normalizeStatus(existing.status) !== STATUS_CANDIDATE) return false;
  if (normalizeStatus(incoming.status) === STATUS_ACTIVE) return true;
  const incomingSourceKind = sanitizeOptionalText(incoming.sourceKind).toLowerCase();
  if (incomingSourceKind === 'explicit' || incomingSourceKind === 'journal' || incomingSourceKind === 'rollup') return true;
  const type = normalizeType(existing.type || incoming.type);
  if (type === 'identity' || type === 'goal' || type === 'summary' || type === 'impression') {
    return Number(existing.confidence || incoming.confidence || 0) >= 0.84;
  }
  const lastConfirmedAt = Number(existing.lastConfirmedAt || 0) || 0;
  const incomingTs = Number(incoming.updatedAt || incoming.createdAt || nowTs()) || nowTs();
  if (!lastConfirmedAt) return false;
  return Math.abs(incomingTs - lastConfirmedAt) >= CANDIDATE_CONFIRM_WINDOW_MS;
}

function shouldDeactivateStaleCandidate(item, now = nowTs()) {
  if (normalizeStatus(item?.status) !== STATUS_CANDIDATE) return false;
  const lastSeen = Number(item?.lastConfirmedAt || item?.updatedAt || item?.createdAt || 0) || 0;
  if (!lastSeen) return false;
  const ageDays = (now - lastSeen) / (24 * 3600 * 1000);
  return ageDays >= CANDIDATE_STALE_HARD_DAYS;
}

function getStaleCandidatePenalty(item, now = nowTs()) {
  if (normalizeStatus(item?.status) !== STATUS_CANDIDATE) return 0;
  const lastSeen = Number(item?.lastConfirmedAt || item?.updatedAt || item?.createdAt || 0) || 0;
  if (!lastSeen) return 0;
  const ageDays = (now - lastSeen) / (24 * 3600 * 1000);
  if (ageDays < CANDIDATE_STALE_SOFT_DAYS) return 0;
  return Math.min(0.45, ((ageDays - CANDIDATE_STALE_SOFT_DAYS) / 90) * 0.45);
}

function isImplicitJournalCue(question = '') {
  const q = sanitizeText(question);
  if (!q) return false;
  return /(涔嬪墠|鍓嶅嚑澶﹟涓婃|鏈€杩憒閭ｅぉ|鍥炲繂|鍥炴兂|璁板緱|last time|recently|the other day|remember)/i.test(q);
}

function getItemMemoryKind(item = {}) {
  return normalizeMemoryKind(item.memoryKind ?? item.meta?.memoryKind);
}

function getRequestedMemoryKinds(options = {}) {
  const kinds = [];
  const single = normalizeMemoryKind(options.memoryKind);
  if (single) kinds.push(single);

  const list = Array.isArray(options.memoryKinds) ? options.memoryKinds : [];
  for (const value of list) {
    const kind = normalizeMemoryKind(value);
    if (kind) kinds.push(kind);
  }

  return Array.from(new Set(kinds));
}

function isSignalMemoryKind(kind = '') {
  return kind === 'style' || kind === 'jargon';
}

function isStyleOrJargonMemory(item = {}) {
  return isSignalMemoryKind(getItemMemoryKind(item));
}

function stripTypePrefix(text) {
  return String(text || '')
    .replace(/^(likes?|dislikes?|goal|impression|recent topic|喜欢|不喜欢|目标|用户印象|最近话题)(?:[:：|\s])*/i, '')
    .trim();
}

// Canonical form is used for dedupe, not for user-facing display.
function canonicalizeText(text) {
  return stripTypePrefix(text)
    .toLowerCase()
        .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCorpusText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cross-lingual hints improve lexical recall when user query and memory text
// are in different languages (e.g., Chinese query vs English memories).
function appendCrossLingualHints(normalizedText, tokens) {
  const text = String(normalizedText || '');
  if (!text) return tokens;

  const out = new Set(Array.isArray(tokens) ? tokens : []);
  const hasZh = /[\u4e00-\u9fa5]/.test(text);

  if (hasZh) {
    if (/[\u5403\u996d\u9910\u5348\u665a\u65e9\u997f\u591c]/.test(text)) {
      ['eat', 'meal', 'lunch', 'dinner', 'breakfast', 'snack'].forEach((x) => out.add(x));
    }
    if (/[\u76ee\u6807\u8ba1\u5212\u4efb\u52a1\u8fbe\u6210\u5b9e\u73b0]/.test(text)) {
      ['goal', 'plan', 'target', 'task', 'objective'].forEach((x) => out.add(x));
    }
    if (/[\u559c\u6b22\u504f\u597d\u98ce\u683c\u5ba1\u7f8e\u7231\u53ef]/.test(text)) {
      ['like', 'prefer', 'preference', 'style', 'aesthetic', 'cute'].forEach((x) => out.add(x));
    }
    if (/[\u8ba8\u538c\u53cd\u611f\u6392\u65a5]/.test(text)) {
      ['dislike', 'hate', 'avoid'].forEach((x) => out.add(x));
    }
    if (/[\u89d2\u8272\u626e\u6f14\u4eba\u8bbe\u8eab\u4efd\u5267\u60c5]/.test(text)) {
      ['roleplay', 'persona', 'character', 'identity'].forEach((x) => out.add(x));
    }
    if (/[\u8003\u8bd5\u590d\u4e60\u5b66\u5907\u6d4b\u9a8c\u8bfe\u7a0b]/.test(text)) {
      ['exam', 'study', 'revision', 'course', 'test'].forEach((x) => out.add(x));
    }
  }

  // Mirror hints: English text can still receive Chinese anchor tokens.
  if (/(eat|meal|lunch|dinner|breakfast|snack|hungry)/.test(text)) {
    ['\u5403\u996d', '\u7528\u9910', '\u5348\u996d', '\u665a\u996d', '\u65e9\u9910'].forEach((x) => out.add(x));
  }
  if (/(goal|plan|target|objective|task)/.test(text)) {
    ['\u76ee\u6807', '\u8ba1\u5212', '\u5b89\u6392', '\u4efb\u52a1', '\u8fbe\u6210'].forEach((x) => out.add(x));
  }
  if (/(like|prefer|preference|style|aesthetic|cute)/.test(text)) {
    ['\u559c\u6b22', '\u504f\u597d', '\u98ce\u683c', '\u5ba1\u7f8e', '\u53ef\u7231'].forEach((x) => out.add(x));
  }
  if (/(dislike|hate|avoid)/.test(text)) {
    ['\u4e0d\u559c\u6b22', '\u8ba8\u538c', '\u53cd\u611f'].forEach((x) => out.add(x));
  }
  if (/(roleplay|persona|character|identity)/.test(text)) {
    ['\u89d2\u8272\u626e\u6f14', '\u4eba\u8bbe', '\u8eab\u4efd', '\u8bbe\u5b9a'].forEach((x) => out.add(x));
  }
  if (/(exam|study|revision|course|test)/.test(text)) {
    ['\u8003\u8bd5', '\u590d\u4e60', '\u5b66\u4e60', '\u5907\u8003'].forEach((x) => out.add(x));
  }

  return Array.from(out);
}

function tokenize(text) {
  const normalized = normalizeCorpusText(text);
  if (!normalized) return [];

  const tokens = [];
  const words = normalized.match(/[a-z0-9]+/g) || [];
  tokens.push(...words);

  const zhChunks = normalized.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const chunk of zhChunks) {
    if (chunk.length === 1) {
      tokens.push(chunk);
      continue;
    }

    if (chunk.length <= 4) tokens.push(chunk);
    for (let i = 0; i < chunk.length - 1; i += 1) {
      tokens.push(chunk.slice(i, i + 2));
    }
  }

  return appendCrossLingualHints(normalized, tokens);
}

function dot(a, b) {
  let sum = 0;
  const small = a.size < b.size ? a : b;
  const big = a.size < b.size ? b : a;
  for (const [key, value] of small.entries()) {
    const match = big.get(key);
    if (match) sum += value * match;
  }
  return sum;
}

function norm(map) {
  let sum = 0;
  for (const value of map.values()) sum += value * value;
  return Math.sqrt(sum) || 1e-9;
}

function cosineMap(a, b) {
  return dot(a, b) / (norm(a) * norm(b));
}

function buildTfidfVec(tokens, df, totalDocs) {
  const tf = {};
  for (const token of tokens) tf[token] = (tf[token] || 0) + 1;

  const vec = new Map();
  for (const [token, count] of Object.entries(tf)) {
    const idf = Math.log((totalDocs + 1) / ((df[token] || 0) + 1)) + 1;
    vec.set(token, (count / tokens.length) * idf);
  }
  return vec;
}

function docVecFromTf(doc, df, totalDocs) {
  const vec = new Map();
  const len = doc.len || 1;
  for (const [token, count] of Object.entries(doc.tf || {})) {
    const idf = Math.log((totalDocs + 1) / ((df[token] || 0) + 1)) + 1;
    vec.set(token, (count / len) * idf);
  }
  return vec;
}

function getTypeRule(type) {
  return TYPE_RULES[normalizeType(type)] || TYPE_RULES.fact;
}

function generateId(userId) {
  return `${String(userId)}_${nowTs()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMemoryItem(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const userId = String(raw.userId || raw.user_id || '').trim();
  const text = sanitizeText(raw.text || raw.content || '');
  if (!userId || !text) return null;

  const type = normalizeType(raw.type);
  const rule = getTypeRule(type);
  const createdAt = Number(raw.createdAt || raw.created_at || raw.ts) || nowTs();
  const updatedAt = Number(raw.updatedAt || raw.updated_at || createdAt) || createdAt;
  const weight = clamp(raw.weight || 1, 0.2, 3);
  const confidence = clamp(raw.confidence ?? raw.meta?.confidence ?? 0.8, 0.01, 1);
  // Importance is a smooth numeric score; "tier" is a discrete label derived from it.
  // Callers may provide either (or both) via top-level fields or meta hints.
  const tierHint = normalizeTier(raw.tier ?? raw.meta?.tier ?? raw.meta?.tierHint ?? raw.meta?.importanceTier);
  const importance = clamp(
    raw.importance ?? raw.meta?.importance ?? (tierHint ? tierToRepresentativeImportance(tierHint) : (rule.importance * weight)),
    0.2,
    3
  );
  const tier = tierHint || importanceToTier(importance, confidence, type);
  const ttlDays = raw.ttlDays ?? raw.ttl_days ?? rule.ttlDays;
  const expiresAt = Number(raw.expiresAt || raw.expires_at)
    || (ttlDays ? createdAt + (Number(ttlDays) * 24 * 3600 * 1000) : null);
  const scope = normalizeScope(raw);
  const memoryKind = normalizeMemoryKind(raw.memoryKind ?? raw.memory_kind ?? raw.meta?.memoryKind ?? raw.meta?.memory_kind);
  const supersedes = Array.isArray(raw.supersedes ?? raw.meta?.supersedes)
    ? (raw.supersedes ?? raw.meta?.supersedes).map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const conflictKeys = Array.isArray(raw.conflictKeys ?? raw.conflict_keys ?? raw.meta?.conflictKeys)
    ? (raw.conflictKeys ?? raw.conflict_keys ?? raw.meta?.conflictKeys)
      .map((key) => sanitizeOptionalText(key))
      .filter(Boolean)
    : [];
  const styleRole = normalizeStyleRole(raw.styleRole ?? raw.style_role ?? raw.meta?.styleRole ?? raw.meta?.style_role);
  const jargonRole = normalizeJargonRole(raw.jargonRole ?? raw.jargon_role ?? raw.meta?.jargonRole ?? raw.meta?.jargon_role);
  const sourceKind = sanitizeOptionalText(raw.sourceKind ?? raw.source_kind ?? raw.meta?.sourceKind ?? raw.meta?.source_kind) || 'legacy';
  const participants = extractParticipants(raw, raw.meta && typeof raw.meta === 'object' ? raw.meta : {});
  const entities = normalizeStringArray(raw.entities ?? raw.meta?.entities ?? extractNamedEntities(text));
  const relations = normalizeStringArray(raw.relations ?? raw.meta?.relations ?? inferRelationsFromText(text, entities, participants));
  const conflictKey = normalizeConflictKey({
    ...raw,
    userId,
    type,
    canonicalText: raw.canonicalText || raw.canonical_text || canonicalizeText(text)
  });
  const status = shouldStartAsCandidate(type, memoryKind, sourceKind, raw.status, confidence)
    ? STATUS_CANDIDATE
    : normalizeStatus(raw.status, STATUS_ACTIVE);
  const evidenceCount = Math.max(1, Math.floor(Number(raw.evidenceCount ?? raw.evidence_count ?? raw.meta?.evidenceCount ?? 1) || 1));
  const lastConfirmedAt = Number(raw.lastConfirmedAt ?? raw.last_confirmed_at ?? raw.meta?.lastConfirmedAt ?? updatedAt) || updatedAt;
  const sourceSessionId = sanitizeOptionalText(raw.sourceSessionId ?? raw.source_session_id ?? raw.meta?.sourceSessionId ?? raw.meta?.source_session_id ?? scope.sessionId);
  const rollupLevel = normalizeEpisodeRollupLevel(raw.rollupLevel ?? raw.rollup_level ?? raw.meta?.rollupLevel ?? raw.meta?.rollup_level);
  const episodeDay = normalizeEpisodeDay(raw.episodeDay ?? raw.episode_day ?? raw.meta?.episodeDay ?? raw.meta?.episode_day);
  const rawMeta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const meta = {
    ...rawMeta,
    ...(memoryKind ? { memoryKind } : {}),
    ...(styleRole ? { styleRole } : {}),
    ...(jargonRole ? { jargonRole } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(participants.length > 0 ? { participants } : {}),
    ...(entities.length > 0 ? { entities } : {}),
    ...(relations.length > 0 ? { relations } : {}),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(rollupLevel ? { rollupLevel } : {}),
    ...(episodeDay ? { episodeDay } : {})
  };

  return {
    id: String(raw.id || generateId(userId)),
    userId,
    text,
    canonicalText: sanitizeText(raw.canonicalText || raw.canonical_text || canonicalizeText(text)),
    type,
    source: String(raw.source || raw.meta?.source || 'unknown').trim() || 'unknown',
    confidence,
    importance,
    tier,
    weight,
    status,
    sourceKind,
    createdAt,
    updatedAt,
    lastAccessAt: Number(raw.lastAccessAt || raw.last_access_at || 0) || 0,
    lastRecalledAt: Number(raw.lastRecalledAt || raw.last_recalled_at || raw.meta?.lastRecalledAt || 0) || 0,
    accessCount: Math.max(0, Math.floor(Number(raw.accessCount || raw.access_count || 0) || 0)),
    recallCount: Math.max(0, Math.floor(Number(raw.recallCount || raw.recall_count || raw.meta?.recallCount || 0) || 0)),
    stabilityScore: clamp(raw.stabilityScore ?? raw.stability_score ?? raw.meta?.stabilityScore ?? 0, 0, 1),
    memoryStrength: clamp(raw.memoryStrength ?? raw.memory_strength ?? raw.meta?.memoryStrength ?? 0, 0, 1.5),
    nextReviewAt: Number(raw.nextReviewAt || raw.next_review_at || raw.meta?.nextReviewAt || 0) || 0,
    mentionCount: Math.max(1, Math.floor(Number(raw.mentionCount || raw.mention_count || 1) || 1)),
    evidenceCount,
    lastConfirmedAt,
    expiresAt,
    scopeType: scope.scopeType,
    groupId: scope.groupId,
    sessionId: scope.sessionId,
    routePolicyKey: scope.routePolicyKey,
    topRouteType: scope.topRouteType,
    agentName: scope.agentName,
    taskType: scope.taskType,
    toolName: scope.toolName,
    channelId: scope.channelId,
    sourceSessionId,
    participants,
    entities,
    relations,
    conflictKey,
    supersedes,
    conflictKeys,
    memoryKind,
    rollupLevel,
    episodeDay,
    meta
  };
}

function defaultLibrary() {
  return { version: LIBRARY_VERSION, items: [] };
}

const memoryShardState = {
  shards: new Map(),
  aggregateLibrary: null,
  aggregateIndex: null,
  aggregateDirty: true
};

function encodeShardOwnerId(value = '') {
  return encodeURIComponent(String(value || '').trim() || 'default');
}

function normalizeShardCategory(value = '') {
  const category = String(value || '').trim().toLowerCase();
  if (['personal', 'journal', 'style', 'task', 'group', 'jargon'].includes(category)) return category;
  return 'personal';
}

function normalizeShardOwnerId(value = '') {
  return sanitizeOptionalText(value) || 'default';
}

function buildShardKey(category = '', ownerId = '') {
  return `${normalizeShardCategory(category)}:${normalizeShardOwnerId(ownerId)}`;
}

function buildShardPaths(category = '', ownerId = '') {
  const normalizedCategory = normalizeShardCategory(category);
  const normalizedOwnerId = normalizeShardOwnerId(ownerId);
  const fileName = encodeShardOwnerId(normalizedOwnerId);
  return {
    itemsFile: path.join(SHARD_ROOT, normalizedCategory, `${fileName}.items.json`),
    indexFile: path.join(SHARD_ROOT, normalizedCategory, `${fileName}.index.json`)
  };
}

function defaultShardItemsPayload(meta = {}) {
  return {
    version: LIBRARY_VERSION,
    shardKey: String(meta.shardKey || ''),
    category: normalizeShardCategory(meta.category),
    ownerId: normalizeShardOwnerId(meta.ownerId),
    items: []
  };
}

function defaultShardIndexPayload(meta = {}) {
  return {
    version: INDEX_VERSION,
    shardKey: String(meta.shardKey || ''),
    category: normalizeShardCategory(meta.category),
    ownerId: normalizeShardOwnerId(meta.ownerId),
    librarySize: 0,
    updatedAt: 0,
    df: {},
    docs: {},
    totalDocs: 0
  };
}

function normalizeShardMeta(raw = {}) {
  const category = normalizeShardCategory(raw.category || raw.scopeCategory || raw.scope || raw.kind);
  const ownerId = normalizeShardOwnerId(raw.ownerId || raw.userId || raw.groupId || raw.owner || '');
  const shardKey = buildShardKey(category, ownerId);
  return {
    shardKey,
    category,
    ownerId,
    ...buildShardPaths(category, ownerId),
    itemCount: Math.max(0, Number(raw.itemCount || 0) || 0),
    updatedAt: Number(raw.updatedAt || 0) || 0
  };
}

function resolveShardCategoryForItem(item = {}) {
  const memoryKind = getItemMemoryKind(item);
  if (memoryKind === 'style') return 'style';
  if (memoryKind === 'jargon') return 'jargon';
  if (
    memoryKind === 'episode'
    || normalizeType(item.type) === 'episode'
    || String(item.sourceKind || '').toLowerCase() === 'journal'
  ) {
    return 'journal';
  }
  const scopeType = normalizeScopeType(item.scopeType);
  if (scopeType === 'task') return 'task';
  if (scopeType === 'group') return 'group';
  return 'personal';
}

function resolveShardOwnerIdForItem(item = {}, category = '') {
  const normalizedCategory = normalizeShardCategory(category || resolveShardCategoryForItem(item));
  if (normalizedCategory === 'group' || normalizedCategory === 'jargon') {
    return normalizeShardOwnerId(item.groupId || item.userId || '');
  }
  return normalizeShardOwnerId(item.userId || '');
}

function createShardMetaForItem(item = {}) {
  const category = resolveShardCategoryForItem(item);
  const ownerId = resolveShardOwnerIdForItem(item, category);
  return normalizeShardMeta({ category, ownerId });
}

function getShardItemsStore(meta = {}) {
  const normalizedMeta = normalizeShardMeta(meta);
  if (!hotStoreRegistry.shardItems.has(normalizedMeta.shardKey)) {
    hotStoreRegistry.shardItems.set(normalizedMeta.shardKey, createJsonHotStore(normalizedMeta.itemsFile, {
      fallback: () => defaultShardItemsPayload(normalizedMeta)
    }));
  }
  return hotStoreRegistry.shardItems.get(normalizedMeta.shardKey);
}

function getShardIndexStore(meta = {}) {
  const normalizedMeta = normalizeShardMeta(meta);
  if (!hotStoreRegistry.shardIndexes.has(normalizedMeta.shardKey)) {
    hotStoreRegistry.shardIndexes.set(normalizedMeta.shardKey, createJsonHotStore(normalizedMeta.indexFile, {
      fallback: () => defaultShardIndexPayload(normalizedMeta)
    }));
  }
  return hotStoreRegistry.shardIndexes.get(normalizedMeta.shardKey);
}

function listAllShardEntries() {
  return Array.from(memoryShardState.shards.values());
}

function saveLibrary(library) {
  ensureShardStateHydrated();
  const nextGroups = new Map();
  const items = Array.isArray(library?.items) ? library.items : [];
  for (const rawItem of items) {
    const item = normalizeMemoryItem(rawItem);
    if (!item) continue;
    const shardMeta = createShardMetaForItem(item);
    const grouped = nextGroups.get(shardMeta.shardKey);
    const list = grouped && Array.isArray(grouped.items) ? grouped.items : [];
    list.push(item);
    nextGroups.set(shardMeta.shardKey, {
      meta: grouped?.meta || shardMeta,
      items: list
    });
  }

  for (const [shardKey, entry] of Array.from(memoryShardState.shards.entries())) {
    if (!nextGroups.has(shardKey)) {
      const nextEntry = ensureShardEntry(entry.meta);
      nextEntry.items.items = [];
      nextEntry.index = materializeShardIndex([], nextEntry.meta);
      getShardItemsStore(nextEntry.meta).replace(nextEntry.items);
      getShardIndexStore(nextEntry.meta).replace(nextEntry.index);
      updateManifestForShard(nextEntry);
    }
  }

  for (const grouped of nextGroups.values()) {
    const entry = ensureShardEntry(grouped.meta);
    entry.items = {
      version: LIBRARY_VERSION,
      shardKey: entry.meta.shardKey,
      category: entry.meta.category,
      ownerId: entry.meta.ownerId,
      items: grouped.items
    };
    entry.index = materializeShardIndex(entry.items.items, entry.meta);
    getShardItemsStore(entry.meta).replace(entry.items);
    getShardIndexStore(entry.meta).replace(entry.index);
    updateManifestForShard(entry);
  }

  syncCompatSnapshots();
}

function migrateLegacyLibrary() {
  ensureShardStateHydrated();
  return loadLibrary();
}

function loadLibrary() {
  ensureShardStateHydrated();
  if (!memoryShardState.aggregateDirty && memoryShardState.aggregateLibrary) {
    return {
      version: LIBRARY_VERSION,
      items: memoryShardState.aggregateLibrary.items.slice()
    };
  }
  syncCompatSnapshots();
  return {
    version: LIBRARY_VERSION,
    items: Array.isArray(memoryShardState.aggregateLibrary?.items)
      ? memoryShardState.aggregateLibrary.items.slice()
      : []
  };
}

function defaultIndex() {
  return {
    version: INDEX_VERSION,
    librarySize: 0,
    updatedAt: 0,
    df: {},
    docs: {}
  };
}

function materializeShardIndex(items = [], meta = {}) {
  const index = {
    version: INDEX_VERSION,
    shardKey: String(meta.shardKey || ''),
    category: normalizeShardCategory(meta.category),
    ownerId: normalizeShardOwnerId(meta.ownerId),
    librarySize: items.length,
    updatedAt: nowTs(),
    df: {},
    docs: {},
    totalDocs: 0
  };
  for (const item of Array.isArray(items) ? items : []) {
    if (normalizeStatus(item.status) === STATUS_ARCHIVED || isExpired(item)) continue;
    const tokens = buildDocTokens(item);
    if (!tokens.length) continue;
    const tf = {};
    for (const token of tokens) tf[token] = (tf[token] || 0) + 1;
    for (const token of new Set(tokens)) {
      index.df[token] = (index.df[token] || 0) + 1;
    }
    index.docs[item.id] = {
      id: item.id,
      userId: item.userId,
      tf,
      len: tokens.length,
      ts: item.updatedAt || item.createdAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      type: item.type,
      text: item.text,
      canonicalText: item.canonicalText,
      source: item.source,
      sourceKind: item.sourceKind || 'legacy',
      confidence: item.confidence,
      importance: item.importance,
      tier: item.tier,
      weight: item.weight,
      status: normalizeStatus(item.status, STATUS_ACTIVE),
      evidenceCount: Number(item.evidenceCount || 1) || 1,
      lastConfirmedAt: Number(item.lastConfirmedAt || item.updatedAt || item.createdAt || 0) || 0,
      lastRecalledAt: item.lastRecalledAt || 0,
      accessCount: item.accessCount,
      recallCount: item.recallCount || 0,
      stabilityScore: item.stabilityScore || 0,
      memoryStrength: item.memoryStrength || 0,
      nextReviewAt: item.nextReviewAt || 0,
      scopeType: item.scopeType,
      groupId: item.groupId,
      sessionId: item.sessionId,
      routePolicyKey: item.routePolicyKey,
      topRouteType: item.topRouteType,
      agentName: item.agentName,
      taskType: item.taskType,
      toolName: item.toolName,
      channelId: item.channelId,
      sourceSessionId: item.sourceSessionId || '',
      participants: Array.isArray(item.participants) ? item.participants : [],
      entities: Array.isArray(item.entities) ? item.entities : [],
      relations: Array.isArray(item.relations) ? item.relations : [],
      conflictKey: item.conflictKey || '',
      supersedes: Array.isArray(item.supersedes) ? item.supersedes : [],
      memoryKind: getItemMemoryKind(item),
      rollupLevel: item.rollupLevel || '',
      episodeDay: item.episodeDay || '',
      styleRole: normalizeStyleRole(item.meta?.styleRole),
      jargonRole: normalizeJargonRole(item.meta?.jargonRole),
      meta: item.meta || {}
    };
  }
  index.totalDocs = Object.keys(index.docs).length;
  return index;
}

function markAggregateDirty() {
  memoryShardState.aggregateDirty = true;
  memoryShardState.aggregateLibrary = null;
  memoryShardState.aggregateIndex = null;
}

function updateManifestForShard(entry = null) {
  const manifestStore = getManifestStore();
  manifestStore.update((manifest) => {
    const next = manifest && typeof manifest === 'object' ? manifest : defaultShardManifest();
    next.version = SHARD_MANIFEST_VERSION;
    next.updatedAt = nowTs();
    if (!next.shards || typeof next.shards !== 'object') next.shards = {};
    if (entry) {
      next.shards[entry.meta.shardKey] = {
        shardKey: entry.meta.shardKey,
        category: entry.meta.category,
        ownerId: entry.meta.ownerId,
        itemCount: Array.isArray(entry.items.items) ? entry.items.items.length : 0,
        updatedAt: nowTs()
      };
    }
    return next;
  });
  manifestStore.flushSync();
}

function syncCompatSnapshots() {
  const aggregateLibrary = {
    version: LIBRARY_VERSION,
    items: listAllShardEntries().flatMap((entry) => Array.isArray(entry.items.items) ? entry.items.items : [])
  };
  const aggregateIndex = {
    version: INDEX_VERSION,
    librarySize: aggregateLibrary.items.length,
    updatedAt: nowTs(),
    df: {},
    docs: {},
    totalDocs: 0
  };
  for (const entry of listAllShardEntries()) {
    const shardIndex = entry.index;
    if (!shardIndex || typeof shardIndex !== 'object') continue;
    for (const [token, count] of Object.entries(shardIndex.df || {})) {
      aggregateIndex.df[token] = (aggregateIndex.df[token] || 0) + Number(count || 0);
    }
    Object.assign(aggregateIndex.docs, shardIndex.docs || {});
  }
  aggregateIndex.totalDocs = Object.keys(aggregateIndex.docs).length;
  getCompatItemsStore().replace(aggregateLibrary);
  getCompatIndexStore().replace(aggregateIndex);
  getCompatItemsStore().flushSync();
  getCompatIndexStore().flushSync();
  memoryShardState.aggregateLibrary = aggregateLibrary;
  memoryShardState.aggregateIndex = aggregateIndex;
  memoryShardState.aggregateDirty = false;
}

function ensureShardEntry(meta = {}) {
  const normalizedMeta = normalizeShardMeta(meta);
  const existing = memoryShardState.shards.get(normalizedMeta.shardKey);
  if (existing) return existing;
  const itemsStore = getShardItemsStore(normalizedMeta);
  const indexStore = getShardIndexStore(normalizedMeta);
  const itemsPayload = itemsStore.read();
  const itemList = Array.isArray(itemsPayload?.items)
    ? itemsPayload.items.map((item) => normalizeMemoryItem(item)).filter(Boolean)
    : [];
  const nextItemsPayload = {
    version: LIBRARY_VERSION,
    shardKey: normalizedMeta.shardKey,
    category: normalizedMeta.category,
    ownerId: normalizedMeta.ownerId,
    items: itemList
  };
  if (!itemsPayload || !Array.isArray(itemsPayload.items)) {
    itemsStore.replace(nextItemsPayload);
  }
  const loadedIndex = indexStore.read();
  const index =
    loadedIndex
    && loadedIndex.version === INDEX_VERSION
    && String(loadedIndex.shardKey || '') === normalizedMeta.shardKey
    ? loadedIndex
    : materializeShardIndex(itemList, normalizedMeta);
  if (!loadedIndex || loadedIndex.version !== INDEX_VERSION || String(loadedIndex.shardKey || '') !== normalizedMeta.shardKey) {
    indexStore.replace(index);
  }
  const entry = {
    meta: normalizedMeta,
    items: nextItemsPayload,
    index
  };
  memoryShardState.shards.set(normalizedMeta.shardKey, entry);
  updateManifestForShard(entry);
  markAggregateDirty();
  return entry;
}

function migrateLibraryItemsToShards(items = []) {
  for (const rawItem of Array.isArray(items) ? items : []) {
    const item = normalizeMemoryItem(rawItem);
    if (!item) continue;
    const shardMeta = createShardMetaForItem(item);
    const entry = ensureShardEntry(shardMeta);
    entry.items.items.push(item);
    entry.index = materializeShardIndex(entry.items.items, entry.meta);
    getShardItemsStore(entry.meta).replace(entry.items);
    getShardIndexStore(entry.meta).replace(entry.index);
    updateManifestForShard(entry);
  }
  syncCompatSnapshots();
}

function ensureShardStateHydrated() {
  if (shardStateHydrated) return;
  shardStateHydrated = true;
  const manifestStore = getManifestStore();
  const manifest = manifestStore.read();
  const shardEntries = manifest && manifest.shards && typeof manifest.shards === 'object'
    ? Object.values(manifest.shards)
    : [];
  for (const shardEntry of shardEntries) {
    ensureShardEntry(shardEntry);
  }
  if (memoryShardState.shards.size > 0) {
    syncCompatSnapshots();
    return;
  }
  const current = safeReadJson(ITEMS_FILE, null);
  if (current && Array.isArray(current.items) && current.items.length > 0) {
    migrateLibraryItemsToShards(current.items);
    manifestStore.update((snapshot) => {
      const next = snapshot && typeof snapshot === 'object' ? snapshot : defaultShardManifest();
      next.migratedAt = next.migratedAt || nowTs();
      return next;
    });
    return;
  }
  const legacy = safeReadJson(LEGACY_LIB_FILE, null);
  if (legacy && Array.isArray(legacy.items) && legacy.items.length > 0) {
    migrateLibraryItemsToShards(legacy.items);
    manifestStore.update((snapshot) => {
      const next = snapshot && typeof snapshot === 'object' ? snapshot : defaultShardManifest();
      next.migratedAt = next.migratedAt || nowTs();
      return next;
    });
    return;
  }
  syncCompatSnapshots();
}

function loadIndex() {
  ensureShardStateHydrated();
  if (!memoryShardState.aggregateDirty && memoryShardState.aggregateIndex) {
    return {
      ...memoryShardState.aggregateIndex,
      df: { ...(memoryShardState.aggregateIndex.df || {}) },
      docs: { ...(memoryShardState.aggregateIndex.docs || {}) }
    };
  }
  syncCompatSnapshots();
  return {
    ...memoryShardState.aggregateIndex,
    df: { ...(memoryShardState.aggregateIndex?.df || {}) },
    docs: { ...(memoryShardState.aggregateIndex?.docs || {}) }
  };
}

function saveIndex(index) {
  const normalized = index && typeof index === 'object' ? index : defaultIndex();
  getCompatIndexStore().replace(normalized);
  memoryShardState.aggregateIndex = normalized;
  memoryShardState.aggregateDirty = false;
}

function isExpired(item, now = nowTs()) {
  if (!item) return true;
  if (normalizeStatus(item.status) === STATUS_ARCHIVED) return true;
  if (!item.expiresAt) return false;
  return now >= item.expiresAt;
}

function pruneLibrary(library) {
  const now = nowTs();
  let changed = false;

  for (const item of library.items) {
    if (normalizeStatus(item.status) === STATUS_ACTIVE && isExpired(item, now)) {
      item.status = STATUS_ARCHIVED;
      item.updatedAt = now;
      changed = true;
      continue;
    }

    if (shouldDeactivateStaleCandidate(item, now)) {
      item.status = STATUS_ARCHIVED;
      item.updatedAt = now;
      changed = true;
    }
  }

  if (archiveRolledUpEpisodes(library, now)) {
    changed = true;
  }

  return changed;
}

function getEpisodeArchiveAgeDays(item = {}, now = nowTs()) {
  const ts = Number(item.updatedAt || item.createdAt || 0) || 0;
  if (!ts) return 0;
  return Math.max(0, (now - ts) / (24 * 3600 * 1000));
}

function isEpisodeMemory(item = {}) {
  return normalizeType(item.type) === 'episode' || getItemMemoryKind(item) === 'episode';
}

function getCoveredRollupLevels(item = {}) {
  const meta = item && typeof item.meta === 'object' ? item.meta : {};
  const values = normalizeStringArray([
    ...(Array.isArray(item.coveredByRollups) ? item.coveredByRollups : []),
    ...(Array.isArray(meta.coveredByRollups) ? meta.coveredByRollups : []),
    ...(Array.isArray(meta.covered_rollups) ? meta.covered_rollups : [])
  ], 6).map((value) => normalizeEpisodeRollupLevel(value)).filter(Boolean);
  return Array.from(new Set(values));
}

function archiveRolledUpEpisodes(library, now = nowTs()) {
  if (!config.MEMORY_DISTILLATION_ENABLED) return false;
  const items = Array.isArray(library?.items) ? library.items : [];
  const byUser = new Map();
  for (const item of items) {
    if (!item) continue;
    const userId = String(item.userId || '').trim();
    if (!userId) continue;
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push(item);
  }

  let changed = false;
  const fourDayArchiveAfter = Math.max(0, Number(config.MEMORY_EPISODE_ARCHIVE_AFTER_4DAY_DAYS) || 10);
  const monthlyArchiveAfter = Math.max(0, Number(config.MEMORY_EPISODE_ARCHIVE_AFTER_MONTHLY_DAYS) || 45);

  for (const userItems of byUser.values()) {
    const activeEpisodes = userItems.filter((item) => isEpisodeMemory(item) && normalizeStatus(item.status, STATUS_ACTIVE) === STATUS_ACTIVE);
    const activeFourDayCoveredKeys = new Set(
      activeEpisodes
        .filter((item) => item.rollupLevel === '4day')
        .flatMap((item) => normalizeStringArray([
          ...(Array.isArray(item.conflictKeys) ? item.conflictKeys : []),
          String(item.conflictKey || '').trim()
        ], 32))
        .filter(Boolean)
    );
    const activeMonthlyCoveredKeys = new Set(
      activeEpisodes
        .filter((item) => item.rollupLevel === 'monthly')
        .flatMap((item) => normalizeStringArray([
          ...(Array.isArray(item.conflictKeys) ? item.conflictKeys : []),
          String(item.conflictKey || '').trim()
        ], 64))
        .filter(Boolean)
    );

    for (const item of activeEpisodes) {
      if (item.rollupLevel !== 'daily') continue;
      const ageDays = getEpisodeArchiveAgeDays(item, now);
      const coveredRollups = getCoveredRollupLevels(item);
      const dailyConflictKey = String(item.conflictKey || '').trim();
      const coveredByFourDay = (dailyConflictKey && activeFourDayCoveredKeys.has(dailyConflictKey)) || coveredRollups.includes('4day');
      const coveredByMonthly = (dailyConflictKey && activeMonthlyCoveredKeys.has(dailyConflictKey)) || coveredRollups.includes('monthly');
      const shouldArchive = (coveredByFourDay && ageDays >= fourDayArchiveAfter)
        || (coveredByMonthly && ageDays >= monthlyArchiveAfter);
      if (!shouldArchive) continue;
      item.status = STATUS_ARCHIVED;
      item.updatedAt = now;
      item.meta = mergeMeta(item.meta, {
        archivedReason: coveredByMonthly ? 'covered_by_monthly_rollup' : 'covered_by_4day_rollup',
        archivedByRollupAt: now
      });
      changed = true;
    }

    for (const item of activeEpisodes) {
      if (item.rollupLevel !== '4day') continue;
      const ageDays = getEpisodeArchiveAgeDays(item, now);
      const coveredRollups = getCoveredRollupLevels(item);
      const fourDayConflictKey = String(item.conflictKey || '').trim();
      const coveredByMonthly = (fourDayConflictKey && activeMonthlyCoveredKeys.has(fourDayConflictKey)) || coveredRollups.includes('monthly');
      if (!coveredByMonthly || ageDays < monthlyArchiveAfter) continue;
      item.status = STATUS_ARCHIVED;
      item.updatedAt = now;
      item.meta = mergeMeta(item.meta, {
        archivedReason: 'covered_by_monthly_rollup',
        archivedByRollupAt: now
      });
      changed = true;
    }
  }

  return changed;
}

function buildDocTokens(item) {
  return tokenize([item.text, item.canonicalText, item.type].filter(Boolean).join(' '));
}

function rebuildMemoryIndex(existingLibrary = null) {
  ensureShardStateHydrated();
  if (existingLibrary && Array.isArray(existingLibrary.items)) {
    saveLibrary(existingLibrary);
  } else {
    for (const entry of listAllShardEntries()) {
      entry.index = materializeShardIndex(entry.items.items, entry.meta);
      getShardIndexStore(entry.meta).replace(entry.index);
      updateManifestForShard(entry);
    }
    syncCompatSnapshots();
  }
  return { ok: true, docs: Object.keys(loadIndex().docs || {}).length };
}

function ensureIndexFresh(library) {
  ensureShardStateHydrated();
  const expectedSize = Array.isArray(library?.items) ? library.items.length : loadLibrary().items.length;
  const index = loadIndex();
  if (
    index.version === INDEX_VERSION
    && Number(index.librarySize || 0) === expectedSize
    && (Number(index.totalDocs || 0) > 0 || expectedSize === 0)
  ) {
    return index;
  }
  rebuildMemoryIndex(library);
  return loadIndex();
}

function jaccardFromTokens(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (!setA.size || !setB.size) return 0;

  let intersection = 0;
  for (const value of setA) {
    if (setB.has(value)) intersection += 1;
  }
  return intersection / (setA.size + setB.size - intersection);
}

function isDuplicateMemory(existing, incoming) {
  if (!existing || !incoming) return false;
  if (existing.userId !== incoming.userId) return false;
  if (existing.type !== incoming.type) return false;
  if (normalizeStatus(existing.status) === STATUS_ARCHIVED) return false;
  if (existing.conflictKey && incoming.conflictKey && existing.conflictKey === incoming.conflictKey) return true;
  if (existing.canonicalText === incoming.canonicalText) return true;

  const a = existing.canonicalText || '';
  const b = incoming.canonicalText || '';
  if (a && b && (a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 4) {
    return true;
  }

  return jaccardFromTokens(buildDocTokens(existing), buildDocTokens(incoming)) >= 0.9;
}

function mergeMeta(a, b) {
  return {
    ...(a && typeof a === 'object' ? a : {}),
    ...(b && typeof b === 'object' ? b : {})
  };
}

function findConflictRecord(library, incoming) {
  if (!incoming || !incoming.conflictKey) return null;
  return library.items.find((item) => {
    if (!item) return false;
    if (String(item.userId || '') !== String(incoming.userId || '')) return false;
    if (String(item.conflictKey || '') !== String(incoming.conflictKey || '')) return false;
    if (normalizeStatus(item.status) === STATUS_ARCHIVED) return false;
    return String(item.canonicalText || '') !== String(incoming.canonicalText || '');
  }) || null;
}

function upsertMemoryItem(library, incoming) {
  const now = nowTs();
  const conflictRecord = findConflictRecord(library, incoming);
  if (conflictRecord) {
    conflictRecord.status = STATUS_ARCHIVED;
    conflictRecord.updatedAt = now;
    conflictRecord.supersedes = Array.from(new Set([...(conflictRecord.supersedes || []), incoming.id]));
    incoming.supersedes = Array.from(new Set([...(incoming.supersedes || []), conflictRecord.id]));
  }

  const found = library.items.find((item) => isDuplicateMemory(item, incoming));
  if (!found) {
    if (incoming.status === STATUS_ACTIVE) {
      incoming.lastConfirmedAt = incoming.lastConfirmedAt || now;
    }
    library.items.push(incoming);
    return { id: incoming.id, inserted: true, supersededId: conflictRecord?.id || '' };
  }

  found.text = incoming.text.length > found.text.length ? incoming.text : found.text;
  found.canonicalText = incoming.canonicalText || found.canonicalText;
  found.updatedAt = now;
  found.weight = Math.max(found.weight, incoming.weight);
  found.importance = Math.max(found.importance, incoming.importance);
  found.confidence = Math.max(found.confidence, incoming.confidence);
  // Keep the strongest tier for duplicate merges, but always ensure tier is present.
  found.tier = maxTier(found.tier, incoming.tier) || importanceToTier(found.importance, found.confidence, found.type);
  found.source = incoming.source || found.source;
  found.mentionCount += 1;
  found.evidenceCount = Math.max(1, Number(found.evidenceCount || 1) || 1) + Math.max(1, Number(incoming.evidenceCount || 1) || 1) - 1;
  found.lastConfirmedAt = now;
  found.status = shouldPromoteCandidate(found, incoming)
    ? STATUS_ACTIVE
    : normalizeStatus(found.status, STATUS_ACTIVE);
  found.expiresAt = incoming.expiresAt || found.expiresAt || null;
  found.scopeType = incoming.scopeType || found.scopeType || 'personal';
  found.groupId = incoming.groupId || found.groupId || '';
  found.sessionId = incoming.sessionId || found.sessionId || '';
  found.routePolicyKey = incoming.routePolicyKey || found.routePolicyKey || '';
  found.topRouteType = incoming.topRouteType || found.topRouteType || '';
  found.agentName = incoming.agentName || found.agentName || '';
  found.taskType = incoming.taskType || found.taskType || '';
  found.toolName = incoming.toolName || found.toolName || '';
  found.channelId = incoming.channelId || found.channelId || '';
  found.sourceKind = incoming.sourceKind || found.sourceKind || 'legacy';
  found.sourceSessionId = incoming.sourceSessionId || found.sourceSessionId || '';
  found.participants = normalizeStringArray([...(found.participants || []), ...(incoming.participants || [])]);
  found.entities = normalizeStringArray([...(found.entities || []), ...(incoming.entities || [])]);
  found.relations = normalizeStringArray([...(found.relations || []), ...(incoming.relations || [])]);
  found.conflictKey = incoming.conflictKey || found.conflictKey || '';
  found.memoryKind = incoming.memoryKind || found.memoryKind || '';
  found.rollupLevel = incoming.rollupLevel || found.rollupLevel || '';
  found.episodeDay = incoming.episodeDay || found.episodeDay || '';
  found.supersedes = Array.from(new Set([...(found.supersedes || []), ...(incoming.supersedes || [])]));
  found.conflictKeys = Array.from(new Set([...(found.conflictKeys || []), ...(incoming.conflictKeys || [])]));
  if (isEpisodeMemory(found)) {
    const coveredByRollups = Array.from(new Set([
      ...getCoveredRollupLevels(found),
      ...getCoveredRollupLevels(incoming)
    ]));
    if (coveredByRollups.length > 0) {
      found.coveredByRollups = coveredByRollups;
    }
  }
  found.meta = mergeMeta(found.meta, incoming.meta);
  return { id: found.id, inserted: false, supersededId: conflictRecord?.id || '' };
}

function addMemoryItem(userId, text, type = 'fact', meta = {}, weight = 1.0) {
  const ids = addMemoryItemsBatch([{
    userId,
    text,
    type,
    weight,
    source: meta?.source || 'manual',
    confidence: meta?.confidence,
    scopeType: meta?.scopeType,
    groupId: meta?.groupId,
    sessionId: meta?.sessionId,
    routePolicyKey: meta?.routePolicyKey,
    topRouteType: meta?.topRouteType,
    agentName: meta?.agentName,
    taskType: meta?.taskType,
    toolName: meta?.toolName,
    channelId: meta?.channelId,
    status: meta?.status,
    sourceKind: meta?.sourceKind,
    sourceSessionId: meta?.sourceSessionId,
    conflictKey: meta?.conflictKey,
    supersedes: meta?.supersedes,
    conflictKeys: meta?.conflictKeys,
    memoryKind: meta?.memoryKind,
    participants: meta?.participants,
    entities: meta?.entities,
    relations: meta?.relations,
    evidenceCount: meta?.evidenceCount,
    lastConfirmedAt: meta?.lastConfirmedAt,
    rollupLevel: meta?.rollupLevel,
    episodeDay: meta?.episodeDay,
    meta
  }]);
  return ids[0] || null;
}

function addMemoryItemsBatch(items = []) {
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => normalizeMemoryItem(item))
    .filter(Boolean);

  if (normalizedItems.length === 0) return [];

  const pipelineEnabled = config.MEMORY_WRITE_PIPELINE_ENABLED !== false;
  if (pipelineEnabled && !addMemoryItemsBatch.__pipelineActive) {
    addMemoryItemsBatch.__pipelineActive = true;
    try {
      const result = commitMemoryWrites(
        normalizedItems,
        (accepted) => addMemoryItemsBatch(accepted),
        { minConfidence: config.MEMORY_EXTRACT_MIN_CONFIDENCE }
      );
      return result.ids;
    } finally {
      addMemoryItemsBatch.__pipelineActive = false;
    }
  }

  ensureShardStateHydrated();
  const ids = [];
  const touchedShardKeys = new Set();
  for (const normalized of normalizedItems) {
    const entry = ensureShardEntry(createShardMetaForItem(normalized));
    pruneLibrary(entry.items);
    const result = upsertMemoryItem(entry.items, normalized);
    entry.index = materializeShardIndex(entry.items.items, entry.meta);
    getShardItemsStore(entry.meta).replace(entry.items);
    getShardIndexStore(entry.meta).replace(entry.index);
    updateManifestForShard(entry);
    touchedShardKeys.add(entry.meta.shardKey);
    ids.push(result.id);
  }

  if (touchedShardKeys.size > 0) {
    syncCompatSnapshots();
  }
  return ids;
}

function getMemoryLayer(doc = {}) {
  const type = normalizeType(doc.type);
  const kind = normalizeMemoryKind(doc.memoryKind ?? doc.meta?.memoryKind);
  const source = classifyDocSource(doc);
  if (type === 'identity' || type === 'summary' || type === 'impression' || kind === 'persona_core') return 'stable_profile';
  if (type === 'like' || type === 'dislike' || type === 'personality' || type === 'hobby' || kind === 'style' || kind === 'jargon') return 'preference_relationship';
  if (source === 'task' || kind === 'task' || type === 'goal') return 'task_commitment';
  if (source === 'recent' || type === 'episode' || type === 'topic') return 'recent_continuity';
  if (normalizeStatus(doc.status, STATUS_ACTIVE) === STATUS_CANDIDATE) return 'candidate';
  return 'personal_fact';
}

function getLayerHalfLifeDays(doc = {}) {
  const layer = getMemoryLayer(doc);
  const rule = getTypeRule(doc.type);
  if (layer === 'stable_profile') return Math.max(Number(rule.halfLifeDays || 0), 1200);
  if (layer === 'preference_relationship') return Math.max(Number(rule.halfLifeDays || 0), 900);
  if (layer === 'task_commitment') return Math.min(Math.max(Number(rule.halfLifeDays || 0), 90), 240);
  if (layer === 'recent_continuity') return normalizeType(doc.type) === 'topic' ? Math.max(3, Number(config.MEMORY_TOPIC_TTL_DAYS) || 21) / 2 : 90;
  if (layer === 'candidate') return 45;
  return Math.max(1, Number(rule.halfLifeDays) || 180);
}

function calcMemoryStrength(doc = {}, options = {}) {
  const enabled = config.MEMORY_FORGETTING_CURVE_ENABLED !== false;
  const now = nowTs();
  const rule = getTypeRule(doc.type);
  const minRecency = enabled ? Math.max(0, Math.min(1, Number(rule.minRecency ?? 0.5))) : Math.max(0, Math.min(1, Number(rule.minRecency ?? 0.5)));
  const anchor = Number(doc.lastRecalledAt || doc.lastAccessAt || doc.lastConfirmedAt || doc.updatedAt || doc.createdAt || doc.ts || now) || now;
  const ageDays = Math.max(0, (now - anchor) / (24 * 3600 * 1000));
  const halfLife = enabled ? getLayerHalfLifeDays(doc) : Math.max(1, Number(rule.halfLifeDays) || 180);
  const decayScore = minRecency + ((1 - minRecency) * Math.exp(-ageDays / Math.max(1, halfLife)));
  const recallCount = Math.max(0, Number(doc.recallCount ?? doc.accessCount ?? 0) || 0);
  const stabilityScore = Math.max(0, Math.min(1, Number(doc.stabilityScore ?? doc.meta?.stabilityScore ?? 0) || 0));
  const rehearsalBoost = config.MEMORY_REHEARSAL_ENABLED === false
    ? 0
    : Math.min(0.18, (Math.log1p(recallCount) * 0.03) + (stabilityScore * 0.08));
  const layer = getMemoryLayer(doc);
  const continuityBonus = shouldBiasToContinuity(String(options.queryFacet || ''))
    && (layer === 'recent_continuity' || layer === 'task_commitment')
    ? Math.max(0, Number(config.MEMORY_CONTINUITY_RECALL_BONUS || 0.18) || 0.18)
    : 0;
  const memoryStrength = Math.max(0, Math.min(1.5, decayScore + rehearsalBoost + continuityBonus));
  const intervalDays = Math.max(1, Math.round(halfLife * Math.max(0.15, Math.min(1, 1 - stabilityScore))));
  return {
    layer,
    decayScore,
    rehearsalBoost,
    continuityBonus,
    memoryStrength,
    forgettingReason: ageDays > halfLife ? 'past_half_life' : (recallCount > 0 ? 'rehearsed' : 'fresh_or_unrehearsed'),
    nextReviewAt: anchor + (intervalDays * 24 * 3600 * 1000)
  };
}
function calcRecencyScore(doc) {
  const rule = getTypeRule(doc.type);
  const ageDays = Math.max(0, (nowTs() - (doc.updatedAt || doc.ts || nowTs())) / (24 * 3600 * 1000));
  const halfLife = Math.max(1, Number(rule.halfLifeDays) || 180);
  const decay = Math.exp((-Math.log(2) * ageDays) / halfLife);
  return Math.max(rule.minRecency, decay);
}

function calcOverlapBoost(queryTokens, doc) {
  const docTokens = Object.keys(doc.tf || {});
  if (!queryTokens.length || !docTokens.length) return 0;

  const querySet = new Set(queryTokens);
  let overlap = 0;
  for (const token of docTokens) {
    if (querySet.has(token)) overlap += 1;
  }
  return overlap / querySet.size;
}

function calcLexicalScore(question = '', doc = {}, index = {}) {
  const queryCanonical = canonicalizeText(question);
  const queryTokens = tokenize(`${question} ${queryCanonical}`);
  if (!queryTokens.length) return 0;
  const totalDocs = Math.max(1, Number(index.totalDocs || Object.keys(index.docs || {}).length) || 1);
  const queryVec = buildTfidfVec(queryTokens, index.df || {}, totalDocs);
  const docVec = docVecFromTf(doc, index.df || {}, totalDocs);
  return cosineMap(queryVec, docVec);
}

function calcDirectBoost(queryCanonical, doc) {
  const docCanonical = String(doc.canonicalText || '');
  if (!queryCanonical || !docCanonical) return 0;
  if (queryCanonical === docCanonical) return 0.35;
  if (queryCanonical.includes(docCanonical) || docCanonical.includes(queryCanonical)) return 0.22;
  return 0;
}

function calcParticipantBoost(doc = {}, options = {}) {
  const requested = normalizeStringArray(options.participants || []);
  const existing = normalizeStringArray(doc.participants || []);
  if (!requested.length || !existing.length) {
    return { score: 0, matched: [] };
  }
  const requestedSet = new Set(requested.map((item) => item.toLowerCase()));
  const matched = existing.filter((item) => requestedSet.has(item.toLowerCase()));
  if (!matched.length) return { score: -0.08, matched: [] };
  return {
    score: Math.min(0.18, matched.length * 0.09),
    matched
  };
}

function calcGraphBoost(question = '', doc = {}, options = {}) {
  if (!config.MEMORY_GRAPH_RERANK_ENABLED) return 0;
  const q = sanitizeText(question).toLowerCase();
  if (!q) return 0;
  const entities = normalizeStringArray(doc.entities || []);
  const relations = normalizeStringArray(doc.relations || []);
  let score = 0;
  for (const entity of entities) {
    if (q.includes(String(entity).toLowerCase())) score += 0.06;
  }
  for (const relation of relations) {
    const parts = String(relation || '').split('->').map((item) => sanitizeOptionalText(item).toLowerCase()).filter(Boolean);
    if (parts.length < 2) continue;
    if (parts.every((part) => q.includes(part))) score += 0.08;
  }
  if (options.participants && options.participants.length && entities.length) {
    score += Math.min(0.04, entities.length * 0.01);
  }
  return Math.min(0.22, score);
}

function calcScopeBoost(doc = {}, options = {}) {
  let score = 0;
  const requestedScopeType = normalizeScopeType(options.scopeType);
  const docScopeType = normalizeScopeType(doc.scopeType);
  if (requestedScopeType && docScopeType === requestedScopeType) score += 0.08;
  if (options.groupId && String(options.groupId) === String(doc.groupId || '')) score += 0.06;
  if (options.taskType && String(options.taskType) === String(doc.taskType || '')) score += 0.05;
  if (options.routePolicyKey && String(options.routePolicyKey) === String(doc.routePolicyKey || '')) score += 0.04;
  if (options.topRouteType && String(options.topRouteType) === String(doc.topRouteType || '')) score += 0.04;
  if (options.sessionId && String(options.sessionId) === String(doc.sessionId || '')) score += 0.03;
  return score;
}

function calcTierBoost(doc = {}) {
  const tier = normalizeTier(doc.tier) || importanceToTier(doc.importance, doc.confidence, doc.type);
  if (tier === 'S') return 0.12;
  if (tier === 'A') return 0.08;
  if (tier === 'C') return -0.03;
  return 0.02;
}

function calcConfidenceBoost(doc = {}) {
  const confidence = clamp(doc.confidence ?? 0.7, 0.01, 1);
  return (confidence - 0.5) * 0.22;
}

function calcDuplicationPenalty(doc = {}, seenCanonical = new Set()) {
  const canonical = String(doc.canonicalText || '').trim();
  if (!canonical) return 0;
  return seenCanonical.has(canonical) ? 0.24 : 0;
}

function calcEmbeddingScore(_query, _doc, _options = {}) {
  // Placeholder for future embedding retrieval.
  // Keep the interface stable so hybrid recall can be enabled later without refactoring callers.
  return 0;
}

function cosineArray(a = [], b = []) {
  const length = Math.min(Array.isArray(a) ? a.length : 0, Array.isArray(b) ? b.length : 0);
  if (length === 0) return 0;

  let dotSum = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const va = Number(a[i]) || 0;
    const vb = Number(b[i]) || 0;
    dotSum += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  if (normA <= 0 || normB <= 0) return 0;
  return dotSum / (Math.sqrt(normA) * Math.sqrt(normB));
}

function getEmbeddingApiBaseUrl() {
  const raw = String(config.MEMORY_EMBEDDING_API_BASE_URL || config.MEMORY_API_BASE_URL || config.API_BASE_URL || '')
    .replace(/\/+$/, '');
  if (!raw) return '';
  if (/\/embeddings$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/embeddings`;
  if (/\/chat\/completions$/i.test(raw)) return raw.replace(/\/chat\/completions$/i, '/embeddings');
  return `${raw}/embeddings`;
}

function getEmbeddingApiKey() {
  return String(config.MEMORY_EMBEDDING_API_KEY || config.MEMORY_API_KEY || config.API_KEY || '').trim();
}

function shouldUseRemoteEmbedding() {
  return Boolean(
    config.MEMORY_HYBRID_RECALL_ENABLED
    && String(config.MEMORY_EMBEDDING_MODEL || '').trim()
    && getEmbeddingApiBaseUrl()
    && getEmbeddingApiKey()
  );
}

async function requestEmbedding(text) {
  if (!shouldUseRemoteEmbedding()) return null;

  if (requestEmbedding.disabledUntil && Date.now() < requestEmbedding.disabledUntil) {
    return null;
  }

  try {
    const resp = await postWithRetry(
      getEmbeddingApiBaseUrl(),
      {
        model: String(config.MEMORY_EMBEDDING_MODEL || '').trim(),
        input: String(text || '')
      },
      0,
      getEmbeddingApiKey()
    );

    const payload = typeof resp?.data === 'string'
      ? (() => {
          try { return JSON.parse(resp.data); } catch (_) { return {}; }
        })()
      : (resp?.data || {});
    const list = Array.isArray(payload?.data) ? payload.data : [];
    const first = list[0];
    requestEmbedding.disabledUntil = 0;
    return Array.isArray(first?.embedding) ? first.embedding : null;
  } catch (e) {
    const status = Number(e?.response?.status || 0) || 0;
    if (status === 404 || status === 400) {
      // Disable remote embeddings for a while when the endpoint clearly does not support embeddings.
      requestEmbedding.disabledUntil = Date.now() + (30 * 60 * 1000);
      console.warn('[vectorMemory] embedding endpoint unavailable, fallback to lexical recall for 30 minutes');
      return null;
    }
    console.error('[vectorMemory] embedding request failed:', e.message);
    return null;
  }
}

function formatReason(doc, lexical, overlap, direct) {
  const reasons = [];
  if (direct >= 0.2) reasons.push('direct-match');
  if (lexical >= 0.2) reasons.push('lexical');
  if (overlap >= 0.3) reasons.push('token-overlap');
  if (doc.type === 'goal') reasons.push('goal-priority');
  if (doc.type === 'impression') reasons.push('user-impression');
  if (doc.type === 'topic') reasons.push('recent-topic');
  if (normalizeStatus(doc.status) === STATUS_CANDIDATE) reasons.push('candidate');
  if (doc.sourceKind === 'explicit') reasons.push('explicit');
  if (doc.type === 'episode') reasons.push('episode');
  return reasons.join(', ') || 'scored';
}

function isStyleOrToneQuery(question = '', options = {}) {
  if (options.forceSignalRecall) return true;
  const text = sanitizeText(question).toLowerCase();
  if (!text) return false;
  return /(\bstyle\b|\btone\b|\bvoice\b|\bjargon\b|\bslang\b|\bphrase\b|\bphrasing\b|\bsound like\b|\blike the user\b|\blike the group\b|语气|风格|说话方式|表达方式|口头禅|黑话|群话|群友|像本人|像群里)/i.test(text);
}

function applySignalRecallAdjustments(score, doc, question = '', options = {}) {
  const kind = getItemMemoryKind(doc);
  if (!isSignalMemoryKind(kind)) return score;
  const styleLikeQuery = isStyleOrToneQuery(question, options);
  if (styleLikeQuery) {
    return score * (kind === 'style' ? 1.08 : 1.04);
  }
  return score * 0.72;
}

function touchAccessStats(userId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;

  const wanted = new Set(ids.map((id) => String(id)));
  ensureShardStateHydrated();
  let changed = false;
  for (const entry of listAllShardEntries()) {
    let shardChanged = false;
    for (const item of entry.items.items) {
      if (String(item.userId) !== String(userId)) continue;
      if (!wanted.has(String(item.id))) continue;
      const touchedAt = nowTs();
      item.lastAccessAt = touchedAt;
      if (config.MEMORY_RECALL_TOUCH_ENABLED !== false) item.lastRecalledAt = touchedAt;
      item.accessCount = Math.max(0, Number(item.accessCount || 0)) + 1;
      item.recallCount = Math.max(0, Number(item.recallCount || 0)) + 1;
      item.stabilityScore = clamp((Number(item.stabilityScore || 0) || 0) + 0.03, 0, 1);
      const strength = calcMemoryStrength(item, {});
      item.memoryStrength = strength.memoryStrength;
      item.nextReviewAt = strength.nextReviewAt;
      shardChanged = true;
      changed = true;
    }
    if (!shardChanged) continue;
    entry.index = materializeShardIndex(entry.items.items, entry.meta);
    getShardItemsStore(entry.meta).replace(entry.items);
    getShardIndexStore(entry.meta).replace(entry.index);
    updateManifestForShard(entry);
  }

  if (changed) {
    syncCompatSnapshots();
  }
}

function filterDocIdsByOptions(docs, userId, options = {}) {
  const wantedKinds = getRequestedMemoryKinds(options);
  return Object.keys(docs).filter((id) => {
    const doc = docs[id];
    if (String(doc.userId) !== String(userId)) return false;
    if (isAssistantPersonaPollution(doc)) return false;
    if (options.scopeType && normalizeScopeType(doc.scopeType) !== normalizeScopeType(options.scopeType)) return false;
    if (options.groupId && String(doc.groupId || '') !== String(options.groupId || '')) return false;
    if (options.taskType && String(doc.taskType || '') !== String(options.taskType || '')) return false;
    if (options.routePolicyKey && String(doc.routePolicyKey || '') !== String(options.routePolicyKey || '')) return false;
    if (options.topRouteType && String(doc.topRouteType || '') !== String(options.topRouteType || '')) return false;
    if (options.agentName && String(doc.agentName || '') !== String(options.agentName || '')) return false;
    if (options.toolName && String(doc.toolName || '') !== String(options.toolName || '')) return false;
    if (options.sessionId && String(doc.sessionId || '') !== String(options.sessionId || '')) return false;
    if (options.status && normalizeStatus(doc.status, STATUS_ACTIVE) !== normalizeStatus(options.status, STATUS_ACTIVE)) return false;
    if (options.sourceKind && String(doc.sourceKind || '').toLowerCase() !== String(options.sourceKind || '').toLowerCase()) return false;
    if (options.memoryKind && getItemMemoryKind(doc) !== normalizeMemoryKind(options.memoryKind)) return false;
    if (options.memoryKind === 'episode' && options.rollupLevel && String(doc.rollupLevel || '') !== String(options.rollupLevel || '')) return false;
    if (options.episodeDay && String(doc.episodeDay || '') !== String(options.episodeDay || '')) return false;
    if (options.excludeTopics && normalizeType(doc.type) === 'topic') return false;
    if (options.excludeCandidates && normalizeStatus(doc.status) === STATUS_CANDIDATE) return false;
    if (wantedKinds.length > 0 && !wantedKinds.includes(getItemMemoryKind(doc))) return false;
    return true;
  });
}

function collectDocsFromShardCategories(categories = []) {
  const selected = {};
  const wanted = new Set((Array.isArray(categories) ? categories : []).map((item) => normalizeShardCategory(item)));
  for (const entry of listAllShardEntries()) {
    if (!wanted.has(entry.meta.category)) continue;
    Object.assign(selected, entry.index?.docs || {});
  }
  return selected;
}

function resolveUnifiedShardCategories(options = {}) {
  const categories = new Set(['personal', 'journal', 'style']);
  if (options.includeTask !== false) categories.add('task');
  const groupIds = normalizeStringArray(options.groupIds || (options.groupId ? [options.groupId] : []), MAX_METADATA_LIST);
  if (groupIds.length > 0 && options.includeGroup !== false) {
    categories.add('group');
    categories.add('jargon');
  }
  if (options.includeEpisodes === false) categories.delete('journal');
  if (options.includeSignals === false) {
    categories.delete('style');
    categories.delete('jargon');
  }
  return Array.from(categories);
}

function classifyDocSource(doc = {}) {
  const memoryKind = getItemMemoryKind(doc);
  if (memoryKind === 'style') return 'style';
  if (memoryKind === 'jargon') return 'jargon';
  if (memoryKind === 'episode' || normalizeType(doc.type) === 'episode' || String(doc.sourceKind || '').toLowerCase() === 'journal') {
    return 'journal';
  }
  const scopeType = normalizeScopeType(doc.scopeType);
  if (scopeType === 'task') return 'task';
  if (scopeType === 'group') return 'group';
  return 'personal';
}

function filterUnifiedDocIds(docs, userId, options = {}) {
  const baseUserId = sanitizeOptionalText(userId);
  const requestedSource = sanitizeOptionalText(options.sourceFilter || options.source).toLowerCase() || 'all';
  const groupIds = normalizeStringArray(options.groupIds || (options.groupId ? [options.groupId] : []), MAX_METADATA_LIST);
  const groupOwners = new Set(groupIds.map((groupId) => `group:${groupId}`));
  const includePersonal = options.includePersonal !== false;
  const includeTask = options.includeTask !== false;
  const includeGroup = options.includeGroup !== false;
  const includeSignals = options.includeSignals !== false;
  const includeEpisodes = options.includeEpisodes !== false;
  const allowedSources = requestedSource === 'all'
    ? new Set(['personal', 'task', 'group', 'journal', 'style', 'jargon'])
    : new Set([requestedSource]);

  return Object.keys(docs).filter((id) => {
    const doc = docs[id];
    const source = classifyDocSource(doc);
    if (isAssistantPersonaPollution(doc)) return false;
    if (!allowedSources.has(source)) return false;

    const ownerId = String(doc.userId || '');
    if (source === 'group' || source === 'jargon') {
      if (!includeGroup) return false;
      if (!groupOwners.size || !groupOwners.has(ownerId)) return false;
    } else if (ownerId !== baseUserId) {
      return false;
    }

    if (!includePersonal && source === 'personal') return false;
    if (!includeTask && source === 'task') return false;
    if (!includeSignals && (source === 'style' || source === 'jargon')) return false;
    if (!includeEpisodes && source === 'journal') return false;

    if (options.memoryKind && getItemMemoryKind(doc) !== normalizeMemoryKind(options.memoryKind)) return false;
    if (options.status && normalizeStatus(doc.status, STATUS_ACTIVE) !== normalizeStatus(options.status, STATUS_ACTIVE)) return false;
    if (options.groupId && source !== 'group' && source !== 'jargon' && options.participantStrict) return false;
    return true;
  });
}

function resolveConflictWinners(scored = []) {
  const byConflictKey = new Map();
  for (const hit of Array.isArray(scored) ? scored : []) {
    const key = sanitizeOptionalText(hit.conflictKey || hit.meta?.conflictKey);
    if (!key) continue;
    if (!byConflictKey.has(key)) byConflictKey.set(key, []);
    byConflictKey.get(key).push(hit);
  }

  const losers = new Set();
  for (const entries of byConflictKey.values()) {
    const ranked = entries.slice().sort((a, b) => {
      const statusA = normalizeStatus(a.status, STATUS_ACTIVE);
      const statusB = normalizeStatus(b.status, STATUS_ACTIVE);
      if (statusA !== statusB) {
        if (statusA === STATUS_ACTIVE) return -1;
        if (statusB === STATUS_ACTIVE) return 1;
      }

      const sourceDelta = sourceKindRank(b.sourceKind) - sourceKindRank(a.sourceKind);
      if (sourceDelta !== 0) return sourceDelta;

      const confidenceDelta = Number(b.confidence || 0) - Number(a.confidence || 0);
      if (confidenceDelta !== 0) return confidenceDelta;

      const importanceDelta = Number(b.importance || 0) - Number(a.importance || 0);
      if (importanceDelta !== 0) return importanceDelta;

      const tierDelta = (TIER_RANK[normalizeTier(b.tier) || 'C'] || 0) - (TIER_RANK[normalizeTier(a.tier) || 'C'] || 0);
      if (tierDelta !== 0) return tierDelta;

      return Number(b.updatedAt || b.ts || 0) - Number(a.updatedAt || a.ts || 0);
    });

    for (let i = 1; i < ranked.length; i += 1) {
      losers.add(String(ranked[i].id));
    }
  }

  return Array.isArray(scored) ? scored.filter((hit) => !losers.has(String(hit.id))) : [];
}

function scoreDocs(userId, ids, docs, index, question, topK, options = {}, embeddingQueryVec = null) {
  const queryCanonical = canonicalizeText(question);
  const queryTokens = tokenize(`${question} ${queryCanonical}`);
  if (!queryTokens.length) return [];

  const totalDocs = Math.max(1, Number(index.totalDocs || Object.keys(docs).length) || 1);
  const queryVec = buildTfidfVec(queryTokens, index.df || {}, totalDocs);
  const queryFacet = String(options.queryFacet || classifyRecallFacet(question)).trim() || 'default_continuity';
  const minScore = clamp(
    options.minScore
      ?? (shouldBiasToContinuity(queryFacet) ? Math.max(0.03, Number(config.MEMORY_RAG_MIN_SCORE ?? 0.16) - 0.07) : Math.max(0.08, Number(config.MEMORY_RAG_MIN_SCORE ?? 0.16) - 0.02)),
    0.01,
    2
  );
  const candidateLimit = Math.max(topK + (shouldBiasToContinuity(queryFacet) ? 8 : 4), Number(options.candidateLimit || config.MEMORY_RAG_CANDIDATE_LIMIT || 24) || 24);
  const journalCue = isImplicitJournalCue(question);

  const scored = [];
  for (const id of ids) {
    const doc = docs[id];
    const docVec = docVecFromTf(doc, index.df || {}, totalDocs);
    const lexical = cosineMap(queryVec, docVec);
    const overlap = calcOverlapBoost(queryTokens, doc);
    const direct = calcDirectBoost(queryCanonical, doc);
    const recencyScore = calcRecencyScore(doc);
    const strength = calcMemoryStrength(doc, { ...options, queryFacet });
    const tier = normalizeTier(doc.tier) || importanceToTier(doc.importance, doc.confidence, doc.type);
    const confidenceBoost = calcConfidenceBoost(doc);
    const tierBoost = calcTierBoost(doc);
    const scopeBoost = calcScopeBoost(doc, options);
    const participant = calcParticipantBoost(doc, options);
    const graphBoost = calcGraphBoost(question, doc, options);
    const staleCandidatePenalty = getStaleCandidatePenalty(doc);
    const candidatePenalty = normalizeStatus(doc.status, STATUS_ACTIVE) === STATUS_CANDIDATE ? 0.08 : 0;
    const source = classifyDocSource(doc);
    const journalBoost = normalizeType(doc.type) === 'episode'
      ? (journalCue ? 0.16 : -0.02)
      : 0;
    const embedding = embeddingQueryVec && Array.isArray(doc.meta?.embedding)
      ? Math.max(0, cosineArray(embeddingQueryVec, doc.meta.embedding))
      : (config.MEMORY_HYBRID_RECALL_ENABLED ? calcEmbeddingScore(question, doc, options) : 0);
    const semantic = config.MEMORY_HYBRID_RECALL_ENABLED ? embedding : 0;
    const lexicalOnly = config.MEMORY_HYBRID_RECALL_ENABLED
      ? (lexical * 0.55) + (overlap * 0.2)
      : (lexical * 0.72) + (overlap * 0.22);
    const directMatch = direct;
    const baseScore = lexicalOnly + (semantic * 0.35) + directMatch;
    const continuityBoost = shouldBiasToContinuity(queryFacet)
      ? (
          (source === 'recent' ? 0.28 : 0)
          + (source === 'task' ? 0.22 : 0)
          + (source === 'journal' ? 0.16 : 0)
          + (source === 'personal' ? 0.04 : 0)
          + (source === 'profile' ? -0.07 : 0)
          + (String(doc.sessionId || '') && options.sessionId && String(doc.sessionId) === String(options.sessionId) ? 0.1 : 0)
        )
      : 0;
    const preferenceBoost = queryFacet === 'preference' || queryFacet === 'identity' || queryFacet === 'relationship'
      ? ((source === 'profile' ? 0.12 : 0) + (source === 'personal' ? 0.06 : 0) + (source === 'recent' ? 0.04 : 0))
      : 0;
    const additiveScore = baseScore
      + (recencyScore * 0.08)
      + (strength.memoryStrength * 0.1)
      + tierBoost
      + confidenceBoost
      + scopeBoost
      + participant.score
      + graphBoost
      + journalBoost
      + continuityBoost
      + preferenceBoost
      - candidatePenalty
      - staleCandidatePenalty;
    const score = applySignalRecallAdjustments(additiveScore, doc, question, options);
    if (score < minScore) continue;

    scored.push({
      id,
      score,
      semantic,
      lexical,
      embedding,
      overlap,
      direct,
      reason: formatReason(doc, lexical, overlap, direct),
      text: doc.text,
      canonicalText: doc.canonicalText,
      type: doc.type,
      ts: doc.ts,
      confidence: doc.confidence,
      importance: doc.importance,
      tier,
      status: normalizeStatus(doc.status, STATUS_ACTIVE),
      sourceKind: doc.sourceKind || 'legacy',
      scopeType: normalizeScopeType(doc.scopeType),
      groupId: String(doc.groupId || ''),
      sessionId: String(doc.sessionId || ''),
      routePolicyKey: String(doc.routePolicyKey || ''),
      topRouteType: String(doc.topRouteType || ''),
      agentName: String(doc.agentName || ''),
      taskType: String(doc.taskType || ''),
      toolName: String(doc.toolName || ''),
      channelId: String(doc.channelId || ''),
      memoryKind: getItemMemoryKind(doc),
      participantsMatched: participant.matched,
      participants: Array.isArray(doc.participants) ? doc.participants : [],
      entities: Array.isArray(doc.entities) ? doc.entities : [],
      relations: Array.isArray(doc.relations) ? doc.relations : [],
      conflictKey: String(doc.conflictKey || ''),
      graphBoost,
      recencyScore,
      memoryLayer: strength.layer,
      memoryStrength: strength.memoryStrength,
      decayScore: strength.decayScore,
      rehearsalBoost: strength.rehearsalBoost,
      continuityRecallBonus: strength.continuityBonus,
      forgettingReason: strength.forgettingReason,
      nextReviewAt: strength.nextReviewAt,
      journalBoost,
      sourceSessionId: String(doc.sourceSessionId || ''),
      rollupLevel: String(doc.rollupLevel || ''),
      episodeDay: String(doc.episodeDay || ''),
      evidenceCount: Number(doc.evidenceCount || 1) || 1,
      styleRole: normalizeStyleRole(doc.styleRole ?? doc.meta?.styleRole),
      jargonRole: normalizeJargonRole(doc.jargonRole ?? doc.meta?.jargonRole),
      meta: doc.meta || {}
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (TIER_RANK[normalizeTier(b.tier) || 'C'] || 0) - (TIER_RANK[normalizeTier(a.tier) || 'C'] || 0);
  });
  const conflictFiltered = resolveConflictWinners(scored.slice(0, candidateLimit));
  const selected = selectDiverseHits(conflictFiltered, Math.max(1, Math.min(20, Number(topK) || 8)));

  const shouldTrackAccess = options.trackAccess ?? config.MEMORY_RAG_TRACK_ACCESS ?? false;
  if (shouldTrackAccess) {
    touchAccessStats(userId, selected.map((item) => item.id));
  }

  return selected;
}

async function scoreDocsAsync(userId, ids, docs, index, question, topK, options = {}, embeddingQueryVec = null) {
  const rerankCandidateLimit = Math.max(
    Number(topK) || 8,
    Number(config.MEMORY_RERANK_MAX_CANDIDATES || 40) || 40
  );
  const baseHits = scoreDocs(userId, ids, docs, index, question, rerankCandidateLimit, {
    ...options,
    trackAccess: false
  }, embeddingQueryVec);
  const reranked = await rerankMemoryCandidates(question, baseHits, {
    ...options,
    userId,
    phase: 'vector_memory'
  });
  const selected = selectDiverseHits(reranked, Math.max(1, Math.min(20, Number(topK) || 8)));

  const shouldTrackAccess = options.trackAccess ?? config.MEMORY_RAG_TRACK_ACCESS ?? false;
  if (shouldTrackAccess) {
    touchAccessStats(userId, selected.map((item) => item.id));
  }

  return selected;
}

function selectDiverseHits(scored, topK) {
  const maxPerType = Math.max(1, Number(config.MEMORY_RAG_MAX_PER_TYPE) || 2);
  // Avoid flooding the prompt with low-importance (tier C) memories.
  const maxLowTier = Math.max(0, Math.floor(Number(config.MEMORY_RAG_MAX_LOW_TIER ?? 2) || 2));
  const selected = [];
  const perType = new Map();
  const perKind = new Map();
  const perEpisode = new Map();
  const seenCanonical = new Set();
  let lowTierUsed = 0;

  function isLowTier(tier) {
    return (normalizeTier(tier) || 'B') === 'C';
  }

  function isHighTier(tier) {
    const t = normalizeTier(tier) || 'B';
    return t === 'S' || t === 'A';
  }

  function canTake(hit, { enforceLowTierCap = true } = {}) {
    if (!hit) return false;
    if (seenCanonical.has(hit.canonicalText)) return false;

    const count = perType.get(hit.type) || 0;
    const perTypeCap = hit.type === 'impression' ? Math.max(1, maxPerType) : maxPerType;
    if (count >= perTypeCap) return false;

    const memoryKind = normalizeMemoryKind(hit.memoryKind);
    if (isSignalMemoryKind(memoryKind)) {
      const kindCount = perKind.get(memoryKind) || 0;
      const signalCap = memoryKind === 'style' ? 1 : 1;
      if (kindCount >= signalCap) return false;
    }

    if (hit.type === 'episode') {
      const episodeCap = 2;
      const key = String(hit.rollupLevel || 'daily');
      if ((perEpisode.get(key) || 0) >= episodeCap) return false;
    }

    if (enforceLowTierCap && maxLowTier > 0 && isLowTier(hit.tier) && lowTierUsed >= maxLowTier) {
      return false;
    }

    return true;
  }

  function take(hit) {
    selected.push(hit);
    perType.set(hit.type, (perType.get(hit.type) || 0) + 1);
    const memoryKind = normalizeMemoryKind(hit.memoryKind);
    if (memoryKind) perKind.set(memoryKind, (perKind.get(memoryKind) || 0) + 1);
    if (hit.type === 'episode') {
      const key = String(hit.rollupLevel || 'daily');
      perEpisode.set(key, (perEpisode.get(key) || 0) + 1);
    }
    seenCanonical.add(hit.canonicalText);
    if (isLowTier(hit.tier)) lowTierUsed += 1;
  }

  // Pass 1: try to include one high-tier memory when available.
  for (const hit of scored) {
    if (selected.length >= topK) break;
    if (hit.type !== 'impression') continue;
    if (!canTake(hit, { enforceLowTierCap: true })) continue;
    take(hit);
    break;
  }

  // Pass 2: try to include one other high-tier memory when available.
  for (const hit of scored) {
    if (selected.length >= topK) break;
    if (!isHighTier(hit.tier)) continue;
    if (!canTake(hit, { enforceLowTierCap: true })) continue;
    take(hit);
    break;
  }

  for (const hit of scored) {
    if (selected.length >= topK) break;
    if (!canTake(hit, { enforceLowTierCap: true })) continue;
    take(hit);
  }

  if (selected.length >= topK) return selected;

  for (const hit of scored) {
    if (selected.length >= topK) break;
    if (selected.find((row) => row.id === hit.id)) continue;
    // Backfill without low-tier/type caps, but still avoid repeating identical canonical memories.
    if (seenCanonical.has(hit.canonicalText)) continue;
    selected.push(hit);
    seenCanonical.add(hit.canonicalText);
  }

  return selected;
}

// Retrieval uses lexical similarity plus direct-match and recency boosts.
function retrieveRelevantMemories(userId, query, topK = 8, options = {}) {
  const question = sanitizeText(query);
  if (!question) return [];

  const library = loadLibrary();
  if (pruneLibrary(library)) {
    saveLibrary(library);
    rebuildMemoryIndex(library);
  }

  const index = ensureIndexFresh(library);
  const docs = index.docs || {};
  const ids = filterDocIdsByOptions(docs, userId, options);
  if (!ids.length) return [];
  return scoreDocs(userId, ids, docs, index, question, topK, options, null);
}

async function retrieveRelevantMemoriesAsync(userId, query, topK = 8, options = {}) {
  const question = sanitizeText(query);
  if (!question) return [];

  const library = loadLibrary();
  if (pruneLibrary(library)) {
    saveLibrary(library);
    rebuildMemoryIndex(library);
  }

  const index = ensureIndexFresh(library);
  const docs = index.docs || {};
  const ids = filterDocIdsByOptions(docs, userId, options);
  if (!ids.length) return [];

  const embeddingQueryVec = shouldUseRemoteEmbedding()
    ? await requestEmbedding(question)
    : null;

  return scoreDocsAsync(userId, ids, docs, index, question, topK, options, embeddingQueryVec);
}

function getMemoryItems(userId = null) {
  const library = loadLibrary();
  if (pruneLibrary(library)) saveLibrary(library);
  if (!userId) return library.items.slice();
  return library.items.filter((item) => String(item.userId) === String(userId));
}

function getMemoryItemsByFilter(filters = {}) {
  const userId = sanitizeOptionalText(filters.userId);
  const status = filters.status ? normalizeStatus(filters.status, STATUS_ACTIVE) : '';
  const sourceKind = sanitizeOptionalText(filters.sourceKind).toLowerCase();
  const memoryKind = normalizeMemoryKind(filters.memoryKind);
  const scopeType = filters.scopeType ? normalizeScopeType(filters.scopeType) : '';
  const groupId = sanitizeOptionalText(filters.groupId);
  const limit = Math.max(1, Math.min(500, Number(filters.limit) || 100));

  return getMemoryItems(userId || null)
    .filter((item) => (status ? normalizeStatus(item.status, STATUS_ACTIVE) === status : true))
    .filter((item) => (sourceKind ? String(item.sourceKind || '').toLowerCase() === sourceKind : true))
    .filter((item) => (memoryKind ? getItemMemoryKind(item) === memoryKind : true))
    .filter((item) => (scopeType ? normalizeScopeType(item.scopeType) === scopeType : true))
    .filter((item) => (groupId ? String(item.groupId || '') === groupId : true))
    .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
    .slice(0, limit);
}

function rememberExplicitMemory(userId, text, options = {}) {
  const scopeType = normalizeScopeType(options.scopeType);
  const groupId = sanitizeOptionalText(options.groupId);
  const uid = scopeType === 'group' && groupId
    ? `group:${groupId}`
    : sanitizeOptionalText(userId);
  const content = sanitizeText(text);
  if (!uid || !content) return null;
  return addMemoryItem(uid, content, options.type || 'fact', {
    ...options,
    source: options.source || 'explicit',
    status: STATUS_ACTIVE,
    sourceKind: 'explicit',
    confidence: options.confidence ?? 1.0,
    evidenceCount: Math.max(1, Number(options.evidenceCount || 1) || 1),
    lastConfirmedAt: options.lastConfirmedAt || nowTs()
  }, options.weight || 1.1);
}

function addEpisodeMemory(userId, text, options = {}) {
  if (!config.MEMORY_EPISODIC_INDEX_ENABLED) return null;
  const uid = sanitizeOptionalText(userId);
  const content = sanitizeText(text);
  if (!uid || !content) return null;
  return addMemoryItem(uid, content, 'episode', {
    ...options,
    source: options.source || 'daily_journal',
    status: STATUS_ACTIVE,
    sourceKind: 'journal',
    memoryKind: 'episode',
    rollupLevel: options.rollupLevel || 'daily',
    episodeDay: options.episodeDay || '',
    confidence: options.confidence ?? 0.92
  }, options.weight || 1.04);
}

function buildUnifiedMemoryOptions(options = {}) {
  const requestedKinds = getRequestedMemoryKinds(options);
  return {
    ...options,
    memoryKinds: requestedKinds.length > 0 ? requestedKinds : options.memoryKinds
  };
}

function retrieveUnifiedMemories(userId, query, topK = 8, options = {}) {
  const question = sanitizeText(query);
  if (!question) return [];

  const library = loadLibrary();
  if (pruneLibrary(library)) {
    saveLibrary(library);
    rebuildMemoryIndex(library);
  }

  const index = ensureIndexFresh(library);
  const docs = collectDocsFromShardCategories(resolveUnifiedShardCategories(options));
  const unifiedOptions = buildUnifiedMemoryOptions(options);
  const ids = filterUnifiedDocIds(docs, userId, unifiedOptions);
  if (!ids.length) return [];
  return scoreDocs(userId, ids, docs, { ...index, docs }, question, topK, unifiedOptions, null);
}

async function retrieveUnifiedMemoriesAsync(userId, query, topK = 8, options = {}) {
  const question = sanitizeText(query);
  if (!question) return [];

  const library = loadLibrary();
  if (pruneLibrary(library)) {
    saveLibrary(library);
    rebuildMemoryIndex(library);
  }

  const index = ensureIndexFresh(library);
  const docs = collectDocsFromShardCategories(resolveUnifiedShardCategories(options));
  const unifiedOptions = buildUnifiedMemoryOptions(options);
  const ids = filterUnifiedDocIds(docs, userId, unifiedOptions);
  if (!ids.length) return [];

  const embeddingQueryVec = shouldUseRemoteEmbedding()
    ? await requestEmbedding(question)
    : null;

  return scoreDocsAsync(userId, ids, docs, { ...index, docs }, question, topK, unifiedOptions, embeddingQueryVec);
}

function getMemoryStats(userId = null) {
  const items = getMemoryItems(userId).filter((item) => normalizeStatus(item.status, STATUS_ACTIVE) !== STATUS_ARCHIVED && !isExpired(item));
  const byType = {};
  const byTier = {};
  const byMemoryKind = {};
  const byStatus = {};
  const bySourceKind = {};
  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    const tier = normalizeTier(item.tier) || importanceToTier(item.importance, item.confidence, item.type);
    byTier[tier] = (byTier[tier] || 0) + 1;
    const memoryKind = getItemMemoryKind(item);
    if (memoryKind) byMemoryKind[memoryKind] = (byMemoryKind[memoryKind] || 0) + 1;
    const status = normalizeStatus(item.status, STATUS_ACTIVE);
    byStatus[status] = (byStatus[status] || 0) + 1;
    const sourceKind = String(item.sourceKind || 'legacy').toLowerCase();
    bySourceKind[sourceKind] = (bySourceKind[sourceKind] || 0) + 1;
  }
  return { total: items.length, byType, byTier, byMemoryKind, byStatus, bySourceKind };
}

// "Core memories" are high-importance, stable items that we want the model to keep in mind.
// We surface them separately from RAG hits so they are less likely to be drowned by topics.
function getCoreMemories(userId, limit = 6, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];

  const cap = Math.max(1, Math.min(30, Number(limit) || 6));
  const minTier = normalizeTier(options.minTier || 'A') || 'A';
  const minRank = TIER_RANK[minTier] ?? 2;
  const now = nowTs();

  const library = loadLibrary();
  if (pruneLibrary(library)) saveLibrary(library);

  const items = library.items
    .filter((item) => String(item.userId) === uid)
    .filter((item) => normalizeStatus(item.status, STATUS_ACTIVE) === STATUS_ACTIVE && !isExpired(item, now))
    .filter((item) => !isStyleOrJargonMemory(item))
    .map((item) => {
      const tier = normalizeTier(item.tier) || importanceToTier(item.importance, item.confidence, item.type);
      return { ...item, tier };
    })
    .filter((item) => (TIER_RANK[item.tier] ?? 0) >= minRank);

  items.sort((a, b) => {
    if (a.type === 'impression' && b.type !== 'impression') return -1;
    if (b.type === 'impression' && a.type !== 'impression') return 1;
    const trA = TIER_RANK[a.tier] ?? 0;
    const trB = TIER_RANK[b.tier] ?? 0;
    if (trA !== trB) return trB - trA;
    const impA = Number(a.importance || 0);
    const impB = Number(b.importance || 0);
    if (impA !== impB) return impB - impA;
    const confA = Number(a.confidence || 0);
    const confB = Number(b.confidence || 0);
    if (confA !== confB) return confB - confA;
    const mentionA = Number(a.mentionCount || 0);
    const mentionB = Number(b.mentionCount || 0);
    if (mentionA !== mentionB) return mentionB - mentionA;
    return Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0);
  });

  return items.slice(0, cap).map((item) => ({
    id: item.id,
    type: item.type,
    text: item.text,
    canonicalText: item.canonicalText,
    confidence: item.confidence,
    importance: item.importance,
    tier: item.tier,
    ts: item.updatedAt || item.createdAt,
    scopeType: normalizeScopeType(item.scopeType),
    groupId: String(item.groupId || ''),
    taskType: String(item.taskType || ''),
    routePolicyKey: String(item.routePolicyKey || ''),
    topRouteType: String(item.topRouteType || ''),
    memoryKind: getItemMemoryKind(item),
    sourceKind: String(item.sourceKind || 'legacy'),
    status: normalizeStatus(item.status, STATUS_ACTIVE),
    meta: item.meta || {}
  }));
}

module.exports = {
  addMemoryItem,
  addMemoryItemsBatch,
  addEpisodeMemory,
  rebuildMemoryIndex,
  retrieveRelevantMemories,
  retrieveRelevantMemoriesAsync,
  retrieveUnifiedMemories,
  retrieveUnifiedMemoriesAsync,
  rememberExplicitMemory,
  getCoreMemories,
  getMemoryItems,
  getMemoryItemsByFilter,
  getMemoryStats,
  touchAccessStats,
  shouldUseRemoteEmbedding,
  requestEmbedding,
  cosineArray
};







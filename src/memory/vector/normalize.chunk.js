const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const { commitMemoryWrites, reviewMemoryWriteCandidate, validateMemoryWrite } = require('../../../utils/memoryWritePipeline');
const {
  getEmbeddingApiBaseUrl,
  getEmbeddingApiKey,
  cosineArray
} = require('../../../utils/memoryEmbeddingClient');
const {
  embedQueryText,
  semanticScoreDoc,
  embedMemoryItems,
  isEmbeddingFresh
} = require('../../../utils/memorySemanticIndex');
const { rerankMemoryCandidates } = require('../../../utils/memoryReranker');
const {
  normalizeTier,
  maxTier,
  tierToRepresentativeImportance,
  importanceToTier,
  TIER_RANK
} = require('../../../utils/memoryTier');
const {
  classifyRecallFacet,
  shouldBiasToContinuity
} = require('../../../utils/recallHeuristics');
const {
  createJsonHotStore
} = require('../../../utils/jsonHotStore');
const {
  calcEmbeddingScore,
  requestEmbedding,
  shouldUseRemoteEmbedding
} = require('./embedding');

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


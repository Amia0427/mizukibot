const fs = require('fs');
const path = require('path');
const config = require('../config');
const { rebuildMemoryIndex } = require('./vectorMemory');
const { loadProjection, runMemoryMigration, saveProjection } = require('./memoryProjection');

const ITEMS_FILE = path.join(config.DATA_DIR, 'memory_items.json');
const SNAPSHOT_DIR = path.join(config.DATA_DIR, 'memory_snapshots');

const DEFAULTS = {
  mode: 'balanced',
  action: 'archive',
  minConfidence: 0.72,
  topicTtlDays: 21,
  dedupeThreshold: 0.9
};

function nowTs() {
  return Date.now();
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[memoryGovernance] read json failed:', filePath, e.message);
    return fallback;
  }
}

function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const text = JSON.stringify(obj, null, 2);
  try {
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.writeFileSync(filePath, text, 'utf-8');
    } finally {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (_) {}
    }
    if (e.code !== 'EPERM' && e.code !== 'EXDEV') throw e;
  }
}

function ensureSnapshotDir() {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
}

function resolveSnapshotPath(snapshotFile) {
  const name = String(snapshotFile || '').trim();
  if (!name) throw new Error('snapshot file is required');
  // Keep snapshot names strict to avoid ../ traversal and arbitrary file reads.
  if (path.basename(name) !== name) throw new Error('invalid snapshot file name');
  if (!/^memory_items_.*\.json$/i.test(name)) throw new Error('invalid snapshot file name');

  const root = path.resolve(SNAPSHOT_DIR);
  const fullPath = path.resolve(path.join(SNAPSHOT_DIR, name));
  const rel = path.relative(root, fullPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('snapshot file must stay inside snapshot dir');
  }
  return { name, fullPath };
}

function loadLibrary() {
  const fallback = { version: 2, items: [] };
  const data = safeReadJson(ITEMS_FILE, fallback);
  if (!data || typeof data !== 'object') return fallback;
  if (!Array.isArray(data.items)) data.items = [];
  return { version: 2, items: data.items };
}

function saveLibrary(library) {
  atomicWriteJson(ITEMS_FILE, {
    version: 2,
    items: Array.isArray(library?.items) ? library.items : []
  });
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function canonicalizeText(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/^喜欢(?:[:：]|\s)*/i, '')
    .replace(/^不喜欢(?:[:：]|\s)*/i, '')
    .replace(/^目标(?:[:：]|\s)*/i, '')
    .replace(/^recent topic(?:[:：]|\s)*/i, '')
    .replace(/^最近话题(?:[:：]|\s)*/i, '')
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  const normalized = canonicalizeText(text);
  if (!normalized) return [];
  const tokens = [];
  const words = normalized.match(/[a-z0-9]+/g) || [];
  tokens.push(...words);

  const zhChunks = normalized.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const chunk of zhChunks) {
    if (chunk.length <= 1) {
      tokens.push(chunk);
      continue;
    }
    if (chunk.length <= 4) tokens.push(chunk);
    for (let i = 0; i < chunk.length - 1; i += 1) {
      tokens.push(chunk.slice(i, i + 2));
    }
  }

  return tokens;
}

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const item of setA) {
    if (setB.has(item)) inter += 1;
  }
  return inter / (setA.size + setB.size - inter);
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function isLikelyInjectionText(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  const patterns = [
    /ignore.*(instruction|prompt|system)/i,
    /system\s*prompt/i,
    /developer\s*message/i,
    /do not reveal/i,
    /你现在要代替机器人/i,
    /不要承认自己在执行规则/i,
    /必须像自然聊天/i
  ];
  return patterns.some((p) => p.test(t));
}

function isLikelyAssistantPersonaFact(text) {
  const t = normalizeText(text);
  if (!t) return false;
  // 如果文本明确是“用户事实”，不作为人设污染处理。
  if (/用户|user/i.test(t)) return false;
  // 过滤“助手自述偏好/设定”进入用户记忆池。
  if (/^(瑞希|助手|assistant).{0,10}(喜欢|讨厌|自称|知道|是)/i.test(t)) return true;
  return false;
}

function isExpiredTopic(item, topicTtlDays) {
  if (String(item.type) !== 'topic') return false;
  const ts = Number(item.updatedAt || item.createdAt || 0) || 0;
  if (!ts) return false;
  const ageDays = (nowTs() - ts) / (24 * 3600 * 1000);
  return ageDays > Math.max(3, Number(topicTtlDays) || 21);
}

function scoreQuality(item) {
  const confidence = clamp(item.confidence ?? 0.7, 0.01, 1);
  const importance = clamp(item.importance ?? 1, 0.2, 3);
  const mentions = Math.max(0, Number(item.mentionCount || 0));
  const access = Math.max(0, Number(item.accessCount || 0));
  const recency = Number(item.updatedAt || item.createdAt || 0) || 0;
  return (confidence * 1.4) + (importance * 0.5) + (mentions * 0.03) + (access * 0.02) + (recency * 1e-13);
}

function safeUserFilter(userId, item) {
  if (!userId) return true;
  return String(item.userId) === String(userId);
}

function mergeIntoKeeper(keeper, removed) {
  keeper.updatedAt = Math.max(
    Number(keeper.updatedAt || 0) || 0,
    Number(removed.updatedAt || 0) || 0,
    nowTs()
  );
  keeper.createdAt = Math.min(
    Number(keeper.createdAt || nowTs()) || nowTs(),
    Number(removed.createdAt || nowTs()) || nowTs()
  );
  keeper.confidence = Math.max(
    clamp(keeper.confidence ?? 0.7, 0.01, 1),
    clamp(removed.confidence ?? 0.7, 0.01, 1)
  );
  keeper.importance = Math.max(
    clamp(keeper.importance ?? 1, 0.2, 3),
    clamp(removed.importance ?? 1, 0.2, 3)
  );
  keeper.weight = Math.max(
    clamp(keeper.weight ?? 1, 0.2, 3),
    clamp(removed.weight ?? 1, 0.2, 3)
  );
  keeper.mentionCount = Math.max(1, Number(keeper.mentionCount || 1)) + Math.max(0, Number(removed.mentionCount || 0));
  keeper.accessCount = Math.max(0, Number(keeper.accessCount || 0)) + Math.max(0, Number(removed.accessCount || 0));
}

function findDuplicateGroups(items, dedupeThreshold = 0.9) {
  const threshold = clamp(dedupeThreshold, 0.75, 0.99);
  const exactBucket = new Map();
  const groups = [];
  const idToGroup = new Map();

  for (const item of items) {
    const key = `${item.userId}|${item.type}|${canonicalizeText(item.text || item.canonicalText || '')}`;
    if (!exactBucket.has(key)) exactBucket.set(key, []);
    exactBucket.get(key).push(item);
  }

  for (const list of exactBucket.values()) {
    if (list.length < 2) continue;
    const groupId = groups.length;
    groups.push(list.map((x) => x.id));
    for (const it of list) idToGroup.set(it.id, groupId);
  }

  const byUserType = new Map();
  for (const item of items) {
    const key = `${item.userId}|${item.type}`;
    if (!byUserType.has(key)) byUserType.set(key, []);
    byUserType.get(key).push(item);
  }

  for (const list of byUserType.values()) {
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      const tokenA = tokenize(a.canonicalText || a.text || '');
      if (!tokenA.length) continue;
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        if (idToGroup.has(a.id) && idToGroup.get(a.id) === idToGroup.get(b.id)) continue;

        const ca = canonicalizeText(a.canonicalText || a.text || '');
        const cb = canonicalizeText(b.canonicalText || b.text || '');
        if (!ca || !cb) continue;

        const containNear = (ca.includes(cb) || cb.includes(ca)) && Math.min(ca.length, cb.length) >= 6;
        const sim = containNear ? 1 : jaccard(tokenA, tokenize(b.canonicalText || b.text || ''));
        if (sim < threshold) continue;

        if (!idToGroup.has(a.id) && !idToGroup.has(b.id)) {
          const groupId = groups.length;
          groups.push([a.id, b.id]);
          idToGroup.set(a.id, groupId);
          idToGroup.set(b.id, groupId);
          continue;
        }

        if (idToGroup.has(a.id) && !idToGroup.has(b.id)) {
          const gid = idToGroup.get(a.id);
          groups[gid].push(b.id);
          idToGroup.set(b.id, gid);
          continue;
        }

        if (!idToGroup.has(a.id) && idToGroup.has(b.id)) {
          const gid = idToGroup.get(b.id);
          groups[gid].push(a.id);
          idToGroup.set(a.id, gid);
          continue;
        }

        const ga = idToGroup.get(a.id);
        const gb = idToGroup.get(b.id);
        if (ga === gb) continue;
        const merged = [...groups[ga], ...groups[gb]];
        groups[ga] = merged;
        groups[gb] = [];
        for (const id of merged) idToGroup.set(id, ga);
      }
    }
  }

  return groups
    .filter((row) => row.length > 1)
    .map((row) => Array.from(new Set(row)));
}

function buildGovernancePlan(rawItems, options = {}) {
  const cfg = {
    ...DEFAULTS,
    ...options
  };
  const mode = String(cfg.mode || 'balanced').toLowerCase() === 'strict' ? 'strict' : 'balanced';
  const action = String(cfg.action || 'archive').toLowerCase() === 'delete' ? 'delete' : 'archive';
  const minConfidence = clamp(cfg.minConfidence, 0.01, 1);
  const topicTtlDays = Math.max(3, Number(cfg.topicTtlDays) || 21);
  const dedupeThreshold = clamp(cfg.dedupeThreshold, 0.75, 0.99);
  const selected = (Array.isArray(rawItems) ? rawItems : []).filter((item) => safeUserFilter(cfg.userId, item));

  const byId = new Map(selected.map((item) => [String(item.id), item]));
  const plans = [];

  for (const item of selected) {
    if (String(item.status || 'active') !== 'active') continue;
    const reasons = [];
    const confidence = clamp(item.confidence ?? 0.7, 0.01, 1);
    const text = normalizeText(item.text);

    if (confidence < minConfidence) reasons.push('low_confidence');
    if (text.length < 2) reasons.push('invalid_too_short');
    if (isExpiredTopic(item, topicTtlDays)) reasons.push('stale_topic');
    if (isLikelyInjectionText(text)) reasons.push('prompt_injection_like');
    if (isLikelyAssistantPersonaFact(text)) reasons.push('assistant_persona_fact');

    if (mode === 'strict') {
      if (text.length > 180) reasons.push('too_verbose');
      if (item.type === 'topic' && confidence < Math.max(0.78, minConfidence + 0.04)) reasons.push('low_quality_topic');
    }

    if (reasons.length > 0) {
      plans.push({
        id: item.id,
        op: action,
        reason: reasons.join('+'),
        mergeTo: ''
      });
    }
  }

  const activeCandidates = selected.filter((item) => String(item.status || 'active') === 'active');
  const duplicateGroups = findDuplicateGroups(activeCandidates, dedupeThreshold);

  for (const group of duplicateGroups) {
    const members = group.map((id) => byId.get(String(id))).filter(Boolean);
    if (members.length < 2) continue;

    members.sort((a, b) => scoreQuality(b) - scoreQuality(a));
    const keeper = members[0];

    for (let i = 1; i < members.length; i += 1) {
      const removeItem = members[i];
      if (plans.some((p) => p.id === removeItem.id)) continue;
      plans.push({
        id: removeItem.id,
        op: action,
        reason: 'duplicate',
        mergeTo: keeper.id
      });
    }
  }

  const keepers = new Map();
  for (const p of plans) {
    if (!p.mergeTo) continue;
    if (!keepers.has(p.mergeTo)) keepers.set(p.mergeTo, []);
    keepers.get(p.mergeTo).push(p.id);
  }

  const stats = {
    scanned: selected.length,
    active_scanned: selected.filter((item) => String(item.status || 'active') === 'active').length,
    planned: plans.length,
    archive: plans.filter((p) => p.op === 'archive').length,
    delete: plans.filter((p) => p.op === 'delete').length,
    low_confidence: plans.filter((p) => p.reason.includes('low_confidence')).length,
    stale_topic: plans.filter((p) => p.reason.includes('stale_topic')).length,
    prompt_injection_like: plans.filter((p) => p.reason.includes('prompt_injection_like')).length,
    assistant_persona_fact: plans.filter((p) => p.reason.includes('assistant_persona_fact')).length,
    duplicate: plans.filter((p) => p.reason === 'duplicate').length,
    merge_keepers: keepers.size
  };

  return {
    options: {
      mode,
      action,
      userId: cfg.userId ? String(cfg.userId) : '',
      minConfidence,
      topicTtlDays,
      dedupeThreshold
    },
    stats,
    plans,
    keepers
  };
}

function listConflictGroups(filters = {}) {
  const userId = normalizeText(filters.userId || filters.user_id);
  const items = loadLibrary().items
    .filter((item) => !userId || String(item.userId || '') === userId)
    .filter((item) => String(item.conflictKey || '').trim());

  const groups = new Map();
  for (const item of items) {
    const key = String(item.conflictKey || '').trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  return Array.from(groups.entries())
    .map(([conflictKey, list]) => {
      const sorted = list
        .slice()
        .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
      return {
        conflictKey,
        userId: String(sorted[0]?.userId || ''),
        size: sorted.length,
        items: sorted.map((item) => ({
          id: item.id,
          text: item.text,
          type: item.type,
          status: item.status,
          sourceKind: item.sourceKind,
          confidence: item.confidence,
          importance: item.importance,
          tier: item.tier,
          updatedAt: item.updatedAt || item.createdAt || 0
        }))
      };
    })
    .filter((row) => row.items.length > 1)
    .sort((a, b) => b.size - a.size || String(a.conflictKey).localeCompare(String(b.conflictKey)));
}

function resolveConflictGroup(conflictKey = '', winnerId = '') {
  const key = normalizeText(conflictKey);
  const chosenWinnerId = normalizeText(winnerId);
  if (!key) throw new Error('conflictKey is required');
  if (!chosenWinnerId) throw new Error('winnerId is required');

  const library = loadLibrary();
  let foundWinner = false;
  let changed = 0;

  for (const item of library.items) {
    if (String(item.conflictKey || '').trim() !== key) continue;
    if (String(item.id || '').trim() === chosenWinnerId) {
      item.status = 'active';
      item.updatedAt = nowTs();
      item.meta = {
        ...(item.meta || {}),
        resolvedByGovernance: true,
        resolvedConflictKey: key
      };
      foundWinner = true;
      changed += 1;
      continue;
    }

    if (String(item.status || '').trim().toLowerCase() !== 'archived') {
      item.status = 'archived';
      item.updatedAt = nowTs();
      item.meta = {
        ...(item.meta || {}),
        archivedReason: 'governance_conflict_resolution',
        resolvedConflictKey: key,
        winnerId: chosenWinnerId
      };
      changed += 1;
    }
  }

  if (!foundWinner) throw new Error('winnerId not found in conflict group');
  if (changed > 0) {
    saveLibrary(library);
    rebuildMemoryIndex(library);
    saveProjection();
  }

  return {
    ok: true,
    conflictKey: key,
    winnerId: chosenWinnerId,
    changed
  };
}

function rebuildMemoryArtifacts() {
  const library = loadLibrary();
  rebuildMemoryIndex(library);
  const projection = saveProjection();
  return {
    ok: true,
    totalItems: Array.isArray(library.items) ? library.items.length : 0,
    projectionUsers: Object.keys(projection.users || {}).length
  };
}

function createSnapshot(label = 'manual') {
  ensureSnapshotDir();
  const safeLabel = String(label || 'manual').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 24) || 'manual';
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const file = `memory_items_${stamp}_${safeLabel}.json`;
  const fullPath = path.join(SNAPSHOT_DIR, file);
  const library = loadLibrary();
  atomicWriteJson(fullPath, library);
  return file;
}

function listSnapshots(limit = 30) {
  ensureSnapshotDir();
  const files = fs.readdirSync(SNAPSHOT_DIR)
    .filter((name) => /^memory_items_.*\.json$/i.test(name))
    .map((name) => {
      const full = path.join(SNAPSHOT_DIR, name);
      const stat = fs.statSync(full);
      return {
        file: name,
        size: stat.size,
        createdAt: stat.mtimeMs
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  return files.slice(0, Math.max(1, Math.min(200, Number(limit) || 30)));
}

function previewGovernance(options = {}) {
  const library = loadLibrary();
  const plan = buildGovernancePlan(library.items, options);
  const previewRows = plan.plans.slice(0, 200).map((row) => {
    const item = library.items.find((it) => String(it.id) === String(row.id));
    return {
      id: row.id,
      userId: item?.userId || '',
      type: item?.type || '',
      text: normalizeText(item?.text || ''),
      op: row.op,
      reason: row.reason,
      mergeTo: row.mergeTo || ''
    };
  });

  return {
    ok: true,
    plan: plan.options,
    stats: plan.stats,
    preview: previewRows
  };
}

function applyGovernance(options = {}) {
  const library = loadLibrary();
  const plan = buildGovernancePlan(library.items, options);
  if (plan.plans.length === 0) {
    return {
      ok: true,
      changed: false,
      snapshot: '',
      plan: plan.options,
      stats: plan.stats,
      after: {
        total: library.items.length,
        active: library.items.filter((x) => String(x.status || 'active') === 'active').length
      }
    };
  }

  const snapshot = createSnapshot('governance');
  const itemMap = new Map(library.items.map((item) => [String(item.id), item]));
  const removeSet = new Set();
  const now = nowTs();

  for (const row of plan.plans) {
    const item = itemMap.get(String(row.id));
    if (!item) continue;

    if (row.mergeTo) {
      const keeper = itemMap.get(String(row.mergeTo));
      if (keeper) mergeIntoKeeper(keeper, item);
    }

    if (row.op === 'delete') {
      removeSet.add(String(row.id));
      continue;
    }

    item.status = 'archived';
    item.updatedAt = now;
    item.meta = {
      ...(item.meta && typeof item.meta === 'object' ? item.meta : {}),
      governance: {
        reason: row.reason,
        at: now
      }
    };
  }

  const nextItems = plan.options.action === 'delete'
    ? library.items.filter((item) => !removeSet.has(String(item.id)))
    : library.items;

  saveLibrary({ version: 2, items: nextItems });
  rebuildMemoryIndex();
  saveProjection();

  return {
    ok: true,
    changed: true,
    snapshot,
    plan: plan.options,
    stats: plan.stats,
    after: {
      total: nextItems.length,
      active: nextItems.filter((x) => String(x.status || 'active') === 'active').length
    }
  };
}

function listMemoryItems(filters = {}) {
  const userId = String(filters.userId || '').trim();
  const type = String(filters.type || '').trim();
  const status = String(filters.status || '').trim();
  const limit = Math.max(1, Math.min(1000, Number(filters.limit) || 200));

  const library = loadLibrary();
  let items = library.items.slice();
  if (userId) items = items.filter((x) => String(x.userId) === userId);
  if (type) items = items.filter((x) => String(x.type) === type);
  if (status) items = items.filter((x) => String(x.status || 'active') === status);

  items.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
  return items.slice(0, limit);
}

function getGovernanceStats(userId = '') {
  const library = loadLibrary();
  const items = library.items.filter((item) => (userId ? String(item.userId) === String(userId) : true));
  const byType = {};
  const byStatus = {};
  const byUser = {};

  for (const item of items) {
    const t = String(item.type || 'fact');
    const s = String(item.status || 'active');
    const u = String(item.userId || '');
    byType[t] = (byType[t] || 0) + 1;
    byStatus[s] = (byStatus[s] || 0) + 1;
    byUser[u] = (byUser[u] || 0) + 1;
  }

  return {
    total: items.length,
    byType,
    byStatus,
    topUsers: Object.entries(byUser)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id, count]) => ({ userId: id, count }))
  };
}

function updateMemoryItem(id, patch = {}) {
  const targetId = String(id || '').trim();
  if (!targetId) throw new Error('id is required');

  const library = loadLibrary();
  const item = library.items.find((x) => String(x.id) === targetId);
  if (!item) throw new Error('memory item not found');

  if (Object.prototype.hasOwnProperty.call(patch, 'text')) {
    const text = normalizeText(patch.text);
    if (!text) throw new Error('text cannot be empty');
    item.text = text;
    item.canonicalText = canonicalizeText(text);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'type')) {
    const t = String(patch.type || '').trim().toLowerCase();
    if (!['fact', 'like', 'dislike', 'goal', 'topic'].includes(t)) {
      throw new Error('invalid type');
    }
    item.type = t;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'confidence')) {
    item.confidence = clamp(patch.confidence, 0.01, 1);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'importance')) {
    item.importance = clamp(patch.importance, 0.2, 3);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    const s = String(patch.status || '').trim().toLowerCase();
    if (!['active', 'archived'].includes(s)) throw new Error('invalid status');
    item.status = s;
  }

  item.updatedAt = nowTs();
  saveLibrary(library);
  rebuildMemoryIndex();
  saveProjection();

  return { ok: true, item };
}

function archiveMemoryItem(id, reason = 'manual_archive') {
  return updateMemoryItem(id, {
    status: 'archived',
    reason
  });
}

function rollbackSnapshot(snapshotFile) {
  ensureSnapshotDir();
  const resolved = resolveSnapshotPath(snapshotFile);

  if (!fs.existsSync(resolved.fullPath)) throw new Error('snapshot file not found');
  const data = safeReadJson(resolved.fullPath, null);
  if (!data || !Array.isArray(data.items)) throw new Error('invalid snapshot data');

  createSnapshot('before_rollback');
  saveLibrary({ version: 2, items: data.items });
  rebuildMemoryIndex();
  saveProjection();

  return {
    ok: true,
    restored: resolved.name,
    total: data.items.length
  };
}

module.exports = {
  listMemoryItems,
  getGovernanceStats,
  previewGovernance,
  applyGovernance,
  listConflictGroups,
  resolveConflictGroup,
  rebuildMemoryArtifacts,
  runMemoryMigration,
  listSnapshots,
  rollbackSnapshot,
  updateMemoryItem,
  archiveMemoryItem
};

const crypto = require('crypto');
const config = require('../../config');
const { normalizeText } = require('../memory-v3/helpers');

const PARTITION_LEGACY = 'legacy';
const PARTITION_USER_BUCKET = 'user_bucket';
const PARTITION_MODES = new Set([PARTITION_LEGACY, PARTITION_USER_BUCKET]);
const DEFAULT_BUCKET_COUNT = 32;

function normalizeLanceDbPartitionMode(value = '') {
  const mode = normalizeText(value || config.MEMORY_LANCEDB_PARTITION_MODE || PARTITION_LEGACY).toLowerCase();
  return PARTITION_MODES.has(mode) ? mode : PARTITION_LEGACY;
}

function resolveLanceDbBucketCount(value = null) {
  const raw = value ?? config.MEMORY_LANCEDB_BUCKET_COUNT ?? DEFAULT_BUCKET_COUNT;
  return Math.max(1, Math.min(256, Math.floor(Number(raw) || DEFAULT_BUCKET_COUNT)));
}

function isUserBucketPartitionMode(options = {}) {
  return normalizeLanceDbPartitionMode(options.partitionMode || options.config?.MEMORY_LANCEDB_PARTITION_MODE) === PARTITION_USER_BUCKET;
}

function stableBucketIndex(value = '', bucketCount = DEFAULT_BUCKET_COUNT) {
  const count = resolveLanceDbBucketCount(bucketCount);
  const key = normalizeText(value) || 'default';
  const digest = crypto.createHash('sha1').update(key, 'utf8').digest();
  const numeric = digest.readUInt32BE(0);
  return numeric % count;
}

function formatBucketSuffix(index = 0) {
  return String(Math.max(0, Number(index) || 0)).padStart(2, '0');
}

function normalizeMemoryTableBase(tableName = '') {
  return normalizeText(tableName || config.MEMORY_LANCEDB_MEMORY_TABLE || 'memory_v3_vectors') || 'memory_v3_vectors';
}

function normalizeWorldbookTable(tableName = '') {
  return normalizeText(tableName || config.MEMORY_LANCEDB_WORLDBOOK_TABLE || 'persona_worldbook_vectors') || 'persona_worldbook_vectors';
}

function resolveMemoryBucketKey(row = {}) {
  const scopeType = normalizeText(row.scopeType || 'personal').toLowerCase();
  if (scopeType === 'group') {
    return {
      kind: 'g',
      key: normalizeText(row.groupId || row.userId || row.sessionKey || row.nodeId || row.id)
    };
  }
  return {
    kind: 'u',
    key: normalizeText(row.userId || row.sessionKey || row.groupId || row.nodeId || row.id)
  };
}

function resolveMemoryBucketTableName(baseTableName = '', row = {}, options = {}) {
  const base = normalizeMemoryTableBase(baseTableName);
  if (!isUserBucketPartitionMode(options)) return base;
  const bucket = resolveMemoryBucketKey(row);
  const bucketCount = resolveLanceDbBucketCount(options.bucketCount || options.config?.MEMORY_LANCEDB_BUCKET_COUNT);
  const index = stableBucketIndex(bucket.key, bucketCount);
  return `${base}_${bucket.kind}_b${formatBucketSuffix(index)}`;
}

function buildAllMemoryBucketTableNames(baseTableName = '', options = {}) {
  const base = normalizeMemoryTableBase(baseTableName);
  const bucketCount = resolveLanceDbBucketCount(options.bucketCount || options.config?.MEMORY_LANCEDB_BUCKET_COUNT);
  const out = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const suffix = formatBucketSuffix(index);
    out.push(`${base}_u_b${suffix}`);
    out.push(`${base}_g_b${suffix}`);
  }
  return out;
}

function isMemoryBucketTableName(tableName = '', baseTableName = '', options = {}) {
  const name = normalizeText(tableName);
  const base = normalizeMemoryTableBase(baseTableName);
  const bucketCount = resolveLanceDbBucketCount(options.bucketCount || options.config?.MEMORY_LANCEDB_BUCKET_COUNT);
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_[ug]_b\\d{2,3}$`);
  if (!pattern.test(name)) return false;
  const match = name.match(/_b(\d{2,3})$/);
  const index = Number(match?.[1]);
  return Number.isInteger(index) && index >= 0 && index < bucketCount;
}

function resolveMemorySearchTableNames(baseTableName = '', context = {}, options = {}) {
  const base = normalizeMemoryTableBase(baseTableName);
  if (!isUserBucketPartitionMode(options)) return [base];

  const bucketCount = resolveLanceDbBucketCount(options.bucketCount || options.config?.MEMORY_LANCEDB_BUCKET_COUNT);
  const userId = normalizeText(context.userId);
  const currentGroup = normalizeText(context.groupId);
  const allowedGroups = Array.from(new Set([
    ...(Array.isArray(context.allowedGroupIds) ? context.allowedGroupIds : []),
    ...(Array.isArray(context.groupIds) ? context.groupIds : []),
    currentGroup
  ].map(normalizeText).filter(Boolean))).sort();
  const targets = [];
  if (userId) {
    targets.push(`${base}_u_b${formatBucketSuffix(stableBucketIndex(userId, bucketCount))}`);
  }
  for (const groupId of allowedGroups) {
    targets.push(`${base}_g_b${formatBucketSuffix(stableBucketIndex(groupId, bucketCount))}`);
  }
  return Array.from(new Set(targets));
}

function groupRowsByMemoryBucket(baseTableName = '', rows = [], options = {}) {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const tableName = resolveMemoryBucketTableName(baseTableName, row, options);
    if (!grouped.has(tableName)) grouped.set(tableName, []);
    grouped.get(tableName).push(row);
  }
  return grouped;
}

function isLanceDbLegacyFallbackEnabled(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'legacyFallbackEnabled')) {
    return options.legacyFallbackEnabled === true;
  }
  if (Object.prototype.hasOwnProperty.call(options.config || {}, 'MEMORY_LANCEDB_LEGACY_FALLBACK_ENABLED')) {
    return options.config.MEMORY_LANCEDB_LEGACY_FALLBACK_ENABLED === true;
  }
  return config.MEMORY_LANCEDB_LEGACY_FALLBACK_ENABLED === true;
}

module.exports = {
  DEFAULT_BUCKET_COUNT,
  PARTITION_LEGACY,
  PARTITION_USER_BUCKET,
  buildAllMemoryBucketTableNames,
  formatBucketSuffix,
  groupRowsByMemoryBucket,
  isLanceDbLegacyFallbackEnabled,
  isMemoryBucketTableName,
  isUserBucketPartitionMode,
  normalizeLanceDbPartitionMode,
  normalizeMemoryTableBase,
  normalizeWorldbookTable,
  resolveLanceDbBucketCount,
  resolveMemoryBucketKey,
  resolveMemoryBucketTableName,
  resolveMemorySearchTableNames,
  stableBucketIndex
};

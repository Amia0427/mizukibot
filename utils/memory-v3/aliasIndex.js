const path = require('path');
const config = require('../../config');
const {
  atomicWriteJson,
  ensureDir,
  normalizeText,
  safeReadJson
} = require('./helpers');

function aliasFilePath() {
  return path.join(config.MEMORY_V3_DIR, 'uri_aliases.json');
}

function nowTs() {
  return Date.now();
}

function normalizeUri(value = '') {
  return normalizeText(value).replace(/\/+$/g, '');
}

function normalizeNamespace(value = '') {
  return normalizeText(value || 'default').toLowerCase() || 'default';
}

function defaultAliasIndex() {
  return { version: 1, updatedAt: 0, aliases: [] };
}

function loadAliasIndex() {
  const filePath = aliasFilePath();
  const data = safeReadJson(filePath, defaultAliasIndex());
  return {
    version: 1,
    updatedAt: Number(data?.updatedAt || 0) || 0,
    aliases: Array.isArray(data?.aliases) ? data.aliases.filter(Boolean) : []
  };
}

function saveAliasIndex(index = defaultAliasIndex()) {
  ensureDir(config.MEMORY_V3_DIR);
  atomicWriteJson(aliasFilePath(), {
    version: 1,
    updatedAt: Number(index.updatedAt || nowTs()) || nowTs(),
    aliases: Array.isArray(index.aliases) ? index.aliases : []
  });
}

function sameAlias(left = {}, right = {}) {
  return normalizeNamespace(left.namespace) === normalizeNamespace(right.namespace)
    && normalizeUri(left.aliasUri).toLowerCase() === normalizeUri(right.aliasUri).toLowerCase();
}

function addMemoryAlias(input = {}) {
  const namespace = normalizeNamespace(input.namespace);
  const aliasUri = normalizeUri(input.aliasUri || input.newUri || input.uri);
  const targetUri = normalizeUri(input.targetUri || input.target || input.ref);
  if (!aliasUri) throw new Error('alias uri is required');
  if (!targetUri) throw new Error('target uri is required');
  if (!/^[a-z][a-z0-9_-]*:\/\//i.test(aliasUri)) throw new Error('alias uri must include a scheme');
  if (!/^[a-z][a-z0-9_-]*:\/\//i.test(targetUri)) throw new Error('target uri must include a scheme');

  const index = loadAliasIndex();
  const createdAt = nowTs();
  const next = {
    namespace,
    aliasUri,
    targetUri,
    priority: Math.max(0, Number(input.priority || 0) || 0),
    disclosure: normalizeText(input.disclosure || ''),
    createdAt,
    updatedAt: createdAt
  };
  const existingIndex = index.aliases.findIndex((item) => sameAlias(item, next));
  if (existingIndex >= 0) {
    next.createdAt = Number(index.aliases[existingIndex].createdAt || createdAt) || createdAt;
    index.aliases[existingIndex] = next;
  } else {
    index.aliases.push(next);
  }
  index.updatedAt = createdAt;
  saveAliasIndex(index);
  return { ok: true, alias: next, action: existingIndex >= 0 ? 'updated' : 'created' };
}

function removeMemoryAlias(input = {}) {
  const namespace = normalizeNamespace(input.namespace);
  const aliasUri = normalizeUri(input.aliasUri || input.uri);
  if (!aliasUri) throw new Error('alias uri is required');
  const index = loadAliasIndex();
  const before = index.aliases.length;
  index.aliases = index.aliases.filter((item) => !sameAlias(item, { namespace, aliasUri }));
  const removed = before - index.aliases.length;
  if (removed > 0) {
    index.updatedAt = nowTs();
    saveAliasIndex(index);
  }
  return { ok: true, removed };
}

function listMemoryAliases(options = {}) {
  const namespace = normalizeNamespace(options.namespace);
  const index = loadAliasIndex();
  return index.aliases
    .filter((item) => normalizeNamespace(item.namespace) === namespace)
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || String(a.aliasUri || '').localeCompare(String(b.aliasUri || '')));
}

function resolveMemoryAlias(uri = '', options = {}) {
  const namespace = normalizeNamespace(options.namespace);
  const target = normalizeUri(uri);
  if (!target) return null;
  const lower = target.toLowerCase();
  const alias = loadAliasIndex().aliases.find((item) => (
    normalizeNamespace(item.namespace) === namespace
    && normalizeUri(item.aliasUri).toLowerCase() === lower
  ));
  return alias || null;
}

module.exports = {
  addMemoryAlias,
  listMemoryAliases,
  loadAliasIndex,
  normalizeNamespace,
  normalizeUri,
  removeMemoryAlias,
  resolveMemoryAlias
};

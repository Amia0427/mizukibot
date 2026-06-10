const path = require('path');
const config = require('../../config');
const {
  atomicWriteJson,
  ensureDir,
  normalizeText,
  safeReadJson
} = require('./helpers');
const {
  normalizeNamespace,
  normalizeUri
} = require('./aliasIndex');

function glossaryFilePath() {
  return path.join(config.MEMORY_V3_DIR, 'trigger_glossary.json');
}

function nowTs() {
  return Date.now();
}

function defaultGlossary() {
  return { version: 1, updatedAt: 0, triggers: [] };
}

function normalizeKeyword(value = '') {
  return normalizeText(value).toLowerCase();
}

function loadTriggerGlossary() {
  const data = safeReadJson(glossaryFilePath(), defaultGlossary());
  return {
    version: 1,
    updatedAt: Number(data?.updatedAt || 0) || 0,
    triggers: Array.isArray(data?.triggers) ? data.triggers.filter(Boolean) : []
  };
}

function saveTriggerGlossary(glossary = defaultGlossary()) {
  ensureDir(config.MEMORY_V3_DIR);
  atomicWriteJson(glossaryFilePath(), {
    version: 1,
    updatedAt: Number(glossary.updatedAt || nowTs()) || nowTs(),
    triggers: Array.isArray(glossary.triggers) ? glossary.triggers : []
  });
}

function sameTrigger(left = {}, right = {}) {
  return normalizeNamespace(left.namespace) === normalizeNamespace(right.namespace)
    && normalizeKeyword(left.keyword) === normalizeKeyword(right.keyword)
    && normalizeUri(left.uri).toLowerCase() === normalizeUri(right.uri).toLowerCase();
}

function addMemoryTriggers(input = {}) {
  const namespace = normalizeNamespace(input.namespace);
  const uri = normalizeUri(input.uri || input.targetUri);
  const keywords = Array.isArray(input.keywords || input.add)
    ? (input.keywords || input.add)
    : [input.keyword].filter(Boolean);
  if (!uri) throw new Error('trigger uri is required');
  if (!keywords.length) throw new Error('trigger keyword is required');
  const glossary = loadTriggerGlossary();
  const changed = [];
  const ts = nowTs();
  for (const raw of keywords) {
    const keyword = normalizeKeyword(raw);
    if (!keyword) continue;
    const next = {
      namespace,
      keyword,
      uri,
      priority: Math.max(0, Number(input.priority || 0) || 0),
      disclosure: normalizeText(input.disclosure || ''),
      createdAt: ts,
      updatedAt: ts
    };
    const existingIndex = glossary.triggers.findIndex((item) => sameTrigger(item, next));
    if (existingIndex >= 0) {
      next.createdAt = Number(glossary.triggers[existingIndex].createdAt || ts) || ts;
      glossary.triggers[existingIndex] = next;
    } else {
      glossary.triggers.push(next);
    }
    changed.push(next);
  }
  glossary.updatedAt = ts;
  saveTriggerGlossary(glossary);
  return { ok: true, added: changed.length, triggers: changed };
}

function removeMemoryTriggers(input = {}) {
  const namespace = normalizeNamespace(input.namespace);
  const uri = normalizeUri(input.uri || input.targetUri);
  const keywords = Array.isArray(input.keywords || input.remove)
    ? (input.keywords || input.remove).map(normalizeKeyword).filter(Boolean)
    : [normalizeKeyword(input.keyword)].filter(Boolean);
  if (!uri && keywords.length === 0) throw new Error('trigger uri or keyword is required');
  const keywordSet = new Set(keywords);
  const glossary = loadTriggerGlossary();
  const before = glossary.triggers.length;
  glossary.triggers = glossary.triggers.filter((item) => {
    if (normalizeNamespace(item.namespace) !== namespace) return true;
    if (uri && normalizeUri(item.uri).toLowerCase() !== uri.toLowerCase()) return true;
    if (keywordSet.size > 0 && !keywordSet.has(normalizeKeyword(item.keyword))) return true;
    return false;
  });
  const removed = before - glossary.triggers.length;
  if (removed > 0) {
    glossary.updatedAt = nowTs();
    saveTriggerGlossary(glossary);
  }
  return { ok: true, removed };
}

function listMemoryTriggers(options = {}) {
  const namespace = normalizeNamespace(options.namespace);
  const uri = normalizeUri(options.uri || '');
  return loadTriggerGlossary().triggers
    .filter((item) => normalizeNamespace(item.namespace) === namespace)
    .filter((item) => !uri || normalizeUri(item.uri).toLowerCase() === uri.toLowerCase())
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || String(a.keyword || '').localeCompare(String(b.keyword || '')));
}

function matchMemoryTriggers(text = '', options = {}) {
  const namespace = normalizeNamespace(options.namespace);
  const source = normalizeText(text).toLowerCase();
  if (!source) return [];
  return listMemoryTriggers({ namespace })
    .filter((item) => item.keyword && source.includes(normalizeKeyword(item.keyword)))
    .slice(0, Math.max(1, Number(options.limit || 12) || 12));
}

function formatTriggerGlossary(options = {}) {
  const rows = listMemoryTriggers(options);
  if (!rows.length) return 'No trigger glossary entries.';
  return rows.map((row) => `${row.keyword} -> ${row.uri}${row.disclosure ? ` (${row.disclosure})` : ''}`).join('\n');
}

module.exports = {
  addMemoryTriggers,
  formatTriggerGlossary,
  listMemoryTriggers,
  loadTriggerGlossary,
  matchMemoryTriggers,
  removeMemoryTriggers
};

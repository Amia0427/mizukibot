const fs = require('fs');
const path = require('path');
const config = require('../../config');
const {
  normalizeText,
  clampText
} = require('../memory-v3/helpers');
const {
  isPrimaryReadEnabled,
  listActiveEntries
} = require('../worldbookDb');

const DEFAULT_DOC_MAX_CHARS = 1200;
const WORLD_BOOK_PREFIX = 'persona_worldbook/';

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeModuleCatalogItem(item = {}) {
  return {
    id: normalizeText(item.id || item.moduleId),
    path: normalizeText(item.path),
    purpose: normalizeText(item.purpose),
    triggerHints: normalizeArray(item.triggerHints).map((entry) => normalizeText(entry)).filter(Boolean),
    tokenCost: Math.max(0, Number(item.tokenCost || 0) || 0),
    priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 100,
    conflictsWith: normalizeArray(item.conflictsWith).map((entry) => normalizeText(entry)).filter(Boolean),
    phase: normalizeText(item.phase, 'all'),
    slot: normalizeText(item.slot, 'general'),
    activationMode: normalizeText(item.activationMode),
    durationTurns: Object.prototype.hasOwnProperty.call(item, 'durationTurns') ? Math.max(0, Number(item.durationTurns || 0) || 0) : undefined,
    durationMs: Object.prototype.hasOwnProperty.call(item, 'durationMs') ? Math.max(0, Number(item.durationMs || 0) || 0) : undefined,
    scope: normalizeArray(item.scope).map((entry) => normalizeText(entry)).filter(Boolean),
    probability: Object.prototype.hasOwnProperty.call(item, 'probability') ? Math.max(0, Math.min(1, Number(item.probability || 0) || 0)) : undefined,
    template: normalizeText(item.template),
    exampleIds: normalizeArray(item.exampleIds).map((entry) => normalizeText(entry)).filter(Boolean)
  };
}

function isWorldbookModule(item = {}) {
  const moduleId = normalizeText(item.id || item.moduleId);
  const relPath = normalizeText(item.path).replace(/\\/g, '/');
  return Boolean(moduleId) && relPath.startsWith(WORLD_BOOK_PREFIX);
}

function getWorldbookModules(catalog = { modules: [] }) {
  return normalizeArray(catalog.modules)
    .map(normalizeModuleCatalogItem)
    .filter(isWorldbookModule);
}

function safeReadText(filePath = '') {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function getModuleFilePath(item = {}) {
  const relPath = normalizeText(item.path).replace(/\\/g, '/');
  if (!relPath) return '';
  return path.join(config.PROMPTS_DIR, ...relPath.split('/'));
}

function getFileMeta(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    return {
      fileMtimeMs: Number(stat.mtimeMs || 0) || 0,
      fileSize: Number(stat.size || 0) || 0
    };
  } catch (_) {
    return {
      fileMtimeMs: 0,
      fileSize: 0
    };
  }
}

function buildWorldbookSearchText(item = {}) {
  const filePath = getModuleFilePath(item);
  const fileText = safeReadText(filePath);
  return clampText([
    item.id,
    item.purpose,
    normalizeArray(item.triggerHints).join(' '),
    path.basename(normalizeText(item.path)),
    fileText
  ].filter(Boolean).join('\n'), DEFAULT_DOC_MAX_CHARS);
}

function shouldReadWorldbookFromSql(options = {}) {
  if (options.sqlPrimaryRead === false || options.useSqlPrimaryRead === false) return false;
  return isPrimaryReadEnabled();
}

function buildSqlWorldbookDocuments(catalog = { modules: [] }) {
  const catalogIds = new Set(getWorldbookModules(catalog).map((item) => item.id).filter(Boolean));
  return listActiveEntries()
    .filter((entry) => catalogIds.size === 0 || catalogIds.has(entry.moduleId || entry.id))
    .map((entry) => ({
      ...entry,
      id: entry.moduleId || entry.id,
      moduleId: entry.moduleId || entry.id,
      path: entry.path || entry.sourcePath,
      text: clampText(entry.text || [
        entry.moduleId || entry.id,
        entry.purpose,
        normalizeArray(entry.triggerHints).join(' '),
        path.basename(normalizeText(entry.sourcePath || entry.path)),
        entry.body
      ].filter(Boolean).join('\n'), DEFAULT_DOC_MAX_CHARS),
      filePath: entry.filePath || (entry.sourcePath ? path.join(config.PROMPTS_DIR, ...entry.sourcePath.split('/')) : ''),
      fileMtimeMs: Number(entry.updatedAt || entry.fileMtimeMs || 0) || 0,
      fileSize: Number(entry.fileSize || Buffer.byteLength(entry.body || '', 'utf8')) || 0
    }))
    .filter((entry) => entry.moduleId && entry.text);
}

function buildWorldbookDocuments(catalog = { modules: [] }, options = {}) {
  if (shouldReadWorldbookFromSql(options)) {
    return buildSqlWorldbookDocuments(catalog);
  }
  return getWorldbookModules(catalog)
    .map((item) => {
      const filePath = getModuleFilePath(item);
      const text = buildWorldbookSearchText(item);
      if (!text) return null;
      return {
        ...item,
        moduleId: item.id,
        filePath,
        text,
        ...getFileMeta(filePath)
      };
    })
    .filter(Boolean);
}

module.exports = {
  DEFAULT_DOC_MAX_CHARS,
  WORLD_BOOK_PREFIX,
  buildWorldbookDocuments,
  buildSqlWorldbookDocuments,
  getWorldbookModules,
  isWorldbookModule,
  shouldReadWorldbookFromSql
};

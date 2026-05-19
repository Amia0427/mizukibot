const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { getJsonLineWriter } = require('../storeRegistry');

function safeMkdir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeReadText(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function safeWriteText(filePath, value = '') {
  fs.writeFileSync(filePath, String(value || ''), 'utf8');
}

function atomicWriteJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const body = JSON.stringify(value, null, 2);
  try {
    fs.writeFileSync(tempPath, body, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, body, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM') throw error;
  }
}

function appendJsonLine(filePath, value) {
  getJsonLineWriter(filePath, {
    debounceMs: Math.max(0, Number(config.HOT_STORE_DEBOUNCE_MS || 250) || 250),
    maxDelayMs: Math.max(0, Number(config.HOT_STORE_MAX_DELAY_MS || 2000) || 2000)
  }).append(value);
}

function getStorePaths() {
  const storeDir = String(config.SELF_IMPROVEMENT_STORE_DIR || path.join(config.DATA_DIR, 'self_improvement')).trim();
  return {
    storeDir,
    eventsFile: path.join(storeDir, 'events.jsonl'),
    patternsFile: path.join(storeDir, 'patterns.json'),
    rulesFile: String(config.SELF_IMPROVEMENT_RULES_FILE || path.join(storeDir, 'promoted_rules.json')).trim(),
    guidesFile: String(config.SELF_IMPROVEMENT_GUIDES_FILE || path.join(storeDir, 'skill_guides.json')).trim()
  };
}

function ensureStore() {
  const paths = getStorePaths();
  safeMkdir(paths.storeDir);
  safeMkdir(path.dirname(paths.rulesFile));
  safeMkdir(path.dirname(paths.guidesFile));
  if (!fs.existsSync(paths.eventsFile)) safeWriteText(paths.eventsFile, '');
  if (!fs.existsSync(paths.patternsFile)) atomicWriteJson(paths.patternsFile, { items: [] });
  if (!fs.existsSync(paths.rulesFile)) atomicWriteJson(paths.rulesFile, { items: [] });
  if (!fs.existsSync(paths.guidesFile)) atomicWriteJson(paths.guidesFile, { items: [] });
  return paths;
}

module.exports = {
  appendJsonLine,
  atomicWriteJson,
  ensureStore,
  getStorePaths,
  safeReadJson,
  safeReadText,
  safeWriteText
};

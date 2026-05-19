const fs = require('fs');
const path = require('path');

function ensureDirSync(dirPath = '') {
  const fullPath = path.resolve(String(dirPath || '').trim());
  if (!fullPath) return '';
  fs.mkdirSync(fullPath, { recursive: true });
  return fullPath;
}

function readJsonFileSafe(filePath = '', fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return parsed;
  } catch (_) {
    return fallback;
  }
}

function writeJsonFileSafe(filePath = '', value = {}) {
  const target = path.resolve(String(filePath || '').trim());
  if (!target) return;
  ensureDirSync(path.dirname(target));
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
}

function appendTextFileSafe(filePath = '', text = '') {
  const target = path.resolve(String(filePath || '').trim());
  const content = String(text || '');
  if (!target || !content) return;
  ensureDirSync(path.dirname(target));
  fs.appendFileSync(target, content, 'utf8');
}

module.exports = {
  appendTextFileSafe,
  ensureDirSync,
  readJsonFileSafe,
  writeJsonFileSafe
};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');

const ACTIVE_STATUSES = new Set(['active']);
const TERMINAL_STATUSES = new Set(['cancelled', 'completed', 'failed']);
const ALLOWED_KINDS = new Set(['message', 'command']);
const ALLOWED_COMMAND_TYPES = new Set(['group_message', 'qzone_post']);
const ALLOWED_SCHEDULE_TYPES = new Set(['once', 'cron']);
const ALLOWED_STATUSES = new Set(['active', 'cancelled', 'completed', 'failed']);

function nowIso() {
  return new Date().toISOString();
}

function nowDateTimeText() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tempPath, text, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, text, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM' && error.code !== 'EXDEV') throw error;
  }
}

function makeTaskId() {
  return `qqtask_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function cloneJson(value, fallback = null) {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function resolveStoreFile(options = {}) {
  const configured = normalizeText(options.filePath || config.SCHEDULED_QQ_TASKS_FILE);
  return configured || path.join(config.DATA_DIR, 'scheduled_qq_tasks.json');
}

module.exports = {
  ACTIVE_STATUSES,
  ALLOWED_COMMAND_TYPES,
  ALLOWED_KINDS,
  ALLOWED_SCHEDULE_TYPES,
  ALLOWED_STATUSES,
  TERMINAL_STATUSES,
  atomicWriteJson,
  cloneJson,
  ensureDir,
  makeTaskId,
  normalizeText,
  nowDateTimeText,
  nowIso,
  resolveStoreFile,
  safeReadJson
};

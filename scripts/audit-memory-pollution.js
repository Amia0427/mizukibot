#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const config = require('../config');
const {
  atomicWriteText,
  getJournalFilePath,
  getUserJournalDir,
  safeReadJson,
  atomicWriteJson,
  toSafeJournalPathSegment
} = require('../utils/dailyJournal/storage');
const { parseJournalEntries } = require('../utils/dailyJournal/text');
const { classifyJournalEntrySafety } = require('../utils/dailyJournal/safety');
const { loadProfileProjection } = require('../utils/memory-v3/storage');
const { isNoisyIdentityText } = require('../utils/memory-v3/profileProjection/evidence');
const {
  classifyRecallPollution,
  hasRecallPollutionInObject,
  isPollutedMemoryText,
  recallPollutionReason
} = require('../utils/recallPollutionGuard');

const REDACTED_TEXT = '[memory-pollution-redacted]';
const TEXT_EXTENSIONS = new Set(['.json', '.jsonl', '.ndjson', '.md', '.txt']);
const DEFAULT_RELATIVE_SCAN_ROOTS = [
  'daily_journal',
  'memory-v3',
  'short_term_bridge.json',
  'post_reply_jobs',
  'langgraph_v2_checkpoints',
  'langgraph_v2_events',
  'style_profile.json',
  'style',
  'social_context.json',
  'social',
  'passive-awareness-decisions.jsonl'
];
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;

function parseArgs(argv = []) {
  const out = { user: '', apply: false, scrub: false, roots: [], includeBackups: false, maxFileBytes: DEFAULT_MAX_FILE_BYTES };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (arg === '--apply') out.apply = true;
    else if (arg === '--scrub') out.scrub = true;
    else if (arg === '--include-backups') out.includeBackups = true;
    else if (arg === '--root') {
      out.roots.push(String(argv[i + 1] || '').trim());
      i += 1;
    } else if (arg.startsWith('--root=')) {
      out.roots.push(arg.slice('--root='.length).trim());
    } else if (arg === '--max-file-bytes') {
      out.maxFileBytes = Math.max(1024 * 1024, Number(argv[i + 1] || DEFAULT_MAX_FILE_BYTES) || DEFAULT_MAX_FILE_BYTES);
      i += 1;
    } else if (arg.startsWith('--max-file-bytes=')) {
      out.maxFileBytes = Math.max(1024 * 1024, Number(arg.slice('--max-file-bytes='.length) || DEFAULT_MAX_FILE_BYTES) || DEFAULT_MAX_FILE_BYTES);
    }
    else if (arg === '--user') {
      out.user = String(argv[i + 1] || '').trim();
      i += 1;
    } else if (arg.startsWith('--user=')) {
      out.user = arg.slice('--user='.length).trim();
    }
  }
  return out;
}

function listJournalDays(userId = '') {
  const dir = getUserJournalDir(userId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.journal\.md$/i.test(name))
    .map((name) => name.slice(0, 10))
    .sort();
}

function auditJournal(userId = '') {
  const findings = [];
  for (const day of listJournalDays(userId)) {
    const entries = parseJournalEntries(fs.readFileSync(getJournalFilePath(userId, day), 'utf8'));
    entries.forEach((entry, index) => {
      const safety = classifyJournalEntrySafety(entry);
      if (!safety.safe) {
        findings.push({
          type: 'journal',
          userId,
          day,
          index,
          reason: safety.reason,
          user: entry.user,
          assistant: entry.assistant
        });
        return;
      }
      const pollutionReason = recallPollutionReason(entry.assistant, { allowBenignContext: false });
      if (pollutionReason) {
        findings.push({
          type: 'journal',
          userId,
          day,
          index,
          reason: pollutionReason,
          user: entry.user,
          assistant: entry.assistant
        });
      }
    });
  }
  return findings;
}

function toAbsScanRoot(root = '') {
  const raw = String(root || '').trim();
  if (!raw) return '';
  return path.isAbsolute(raw) ? raw : path.join(config.DATA_DIR, raw);
}

function defaultScanRoots(includeBackups = false) {
  const roots = DEFAULT_RELATIVE_SCAN_ROOTS.map(toAbsScanRoot);
  if (includeBackups) {
    try {
      for (const name of fs.readdirSync(config.DATA_DIR)) {
        if (/memory-v3-backup-/i.test(name)) roots.push(path.join(config.DATA_DIR, name));
      }
    } catch (_) {}
  }
  return roots;
}

function shouldScanFile(filePath = '') {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function listScanFiles(roots = [], options = {}) {
  const files = [];
  const seen = new Set();
  const visit = (target) => {
    const abs = path.resolve(target);
    if (seen.has(abs)) return;
    seen.add(abs);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (_) {
      return;
    }
    if (stat.isDirectory()) {
      const base = path.basename(abs);
      if (!options.includeBackups && /memory-v3-backup-/i.test(base)) return;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        visit(path.join(abs, entry.name));
      }
      return;
    }
    if (!stat.isFile() || !shouldScanFile(abs)) return;
    if (stat.size > Math.max(1024 * 1024, Number(options.maxFileBytes || DEFAULT_MAX_FILE_BYTES))) return;
    files.push(abs);
  };
  for (const root of roots) visit(root);
  return files.sort();
}

function redactPollutedString(value = '', options = {}) {
  const text = String(value || '');
  if (!text || !isPollutedMemoryText(text, { allowBenignContext: options.allowBenignContext !== false })) {
    return { changed: false, value: text };
  }
  return { changed: true, value: REDACTED_TEXT };
}

function scrubJsonValue(value, options = {}) {
  if (typeof value === 'string') return redactPollutedString(value, options);
  if (!value || typeof value !== 'object') return { changed: false, value };
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = scrubJsonValue(item, options);
      changed = changed || result.changed;
      return result.value;
    });
    return { changed, value: next };
  }
  let changed = false;
  const next = {};
  let redactedKeyCount = 0;
  for (const [key, item] of Object.entries(value)) {
    let nextKey = key;
    if (isPollutedMemoryText(key, { allowBenignContext: options.allowBenignContext !== false })) {
      changed = true;
      redactedKeyCount += 1;
      nextKey = `${REDACTED_TEXT}:${redactedKeyCount}`;
    }
    const result = scrubJsonValue(item, options);
    changed = changed || result.changed;
    next[nextKey] = result.value;
  }
  if (changed) {
    next.memoryPollution = {
      ...(next.memoryPollution && typeof next.memoryPollution === 'object' ? next.memoryPollution : {}),
      redacted: true,
      reason: 'recall_pollution',
      redactedAt: new Date().toISOString()
    };
    if (typeof next.status === 'string' && ['active', 'candidate'].includes(next.status)) {
      next.status = 'archived';
    }
    if (typeof next.lifecycleStatus === 'string') {
      next.lifecycleStatus = 'suspect';
    }
  }
  return { changed, value: next };
}

function scrubJsonFile(filePath, raw, apply = false) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { changed: false, reason: 'json_parse_failed' };
  }
  const result = scrubJsonValue(parsed, { allowBenignContext: false });
  if (apply && result.changed) {
    atomicWriteJson(filePath, result.value);
  }
  return { changed: result.changed, reason: result.changed ? 'json_redacted' : '' };
}

function scrubJsonLinesFile(filePath, raw, apply = false) {
  const lines = String(raw || '').split(/\r?\n/);
  let changed = false;
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      out.push(line);
      continue;
    }
    const result = scrubJsonValue(parsed, { allowBenignContext: false });
    changed = changed || result.changed;
    out.push(result.changed ? JSON.stringify(result.value) : line);
  }
  if (apply && changed) {
    atomicWriteText(filePath, `${out.join('\n')}${out.length ? '\n' : ''}`);
  }
  return { changed, reason: changed ? 'jsonl_redacted' : '' };
}

function scrubJournalMarkdownFile(filePath, raw, apply = false) {
  const text = String(raw || '');
  if (!/\.journal\.md$/i.test(filePath)) return { changed: false, reason: '' };
  const blocks = text
    .split(/\n(?=## )/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!blocks.length) return { changed: false, reason: '' };
  let removed = 0;
  const kept = [];
  for (const block of blocks) {
    const entries = parseJournalEntries(block);
    if (!entries.length) {
      kept.push(block);
      continue;
    }
    const unsafe = entries.some((entry) => !classifyJournalEntrySafety(entry).safe
      || isPollutedMemoryText(entry.assistant, { allowBenignContext: false }));
    if (unsafe) {
      removed += 1;
      continue;
    }
    kept.push(block);
  }
  if (removed <= 0) return { changed: false, reason: '' };
  if (apply) {
    atomicWriteText(filePath, `${kept.join('\n\n')}${kept.length ? '\n' : ''}`);
  }
  return { changed: true, reason: 'journal_entries_removed', removed };
}

function scrubTextFile(filePath, apply = false) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { file: filePath, changed: false, reason: `read_failed:${error.message}` };
  }
  if (!raw || !isPollutedMemoryText(raw, { allowBenignContext: false }) && !hasRecallPollutionInObject(raw, { allowBenignContext: false })) {
    return { file: filePath, changed: false, reason: '' };
  }
  const journalResult = scrubJournalMarkdownFile(filePath, raw, apply);
  if (journalResult.changed) return { file: filePath, ...journalResult };
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    const result = scrubJsonFile(filePath, raw, apply);
    return { file: filePath, ...result };
  }
  if (ext === '.jsonl' || ext === '.ndjson') {
    const result = scrubJsonLinesFile(filePath, raw, apply);
    return { file: filePath, ...result };
  }
  if (isPollutedMemoryText(raw, { allowBenignContext: false })) {
    const next = REDACTED_TEXT;
    if (apply) atomicWriteText(filePath, next);
    return { file: filePath, changed: true, reason: 'text_redacted' };
  }
  return { file: filePath, changed: false, reason: 'benign_context_only' };
}

function scrubFiles(options = {}) {
  const roots = options.roots && options.roots.length
    ? options.roots.map(toAbsScanRoot)
    : defaultScanRoots(options.includeBackups);
  const files = listScanFiles(roots, options);
  const changed = [];
  for (const file of files) {
    const result = scrubTextFile(file, options.apply === true);
    if (result.changed) changed.push(result);
  }
  return {
    roots,
    scanned: files.length,
    changed
  };
}

function scrubProfileJournalDb(options = {}) {
  let db;
  try {
    db = require('../utils/profileJournalDb').getDb({ force: true });
  } catch (error) {
    return { ok: false, reason: `db_load_failed:${error.message}` };
  }
  if (!db) return { ok: false, reason: 'profile_journal_db_unavailable' };
  const now = Date.now();
  const findings = {
    profileFacts: [],
    journalEntries: [],
    journalRollups: []
  };
  const cleanupStmt = db.prepare(`
    INSERT INTO memory_cleanups (target_table, target_id, action, reason, before_json, after_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const markProfile = db.prepare(`UPDATE profile_facts SET status = 'rejected', updated_at = ? WHERE id = ?`);
  for (const row of db.prepare(`SELECT * FROM profile_facts WHERE status IN ('active', 'candidate')`).all()) {
    const pollution = classifyRecallPollution(row.value, { allowBenignContext: false });
    if (!pollution.polluted) continue;
    findings.profileFacts.push({ id: row.id, userId: row.user_id, fieldKey: row.field_key, reason: pollution.reason });
    if (options.apply === true) {
      const next = { ...row, status: 'rejected', updated_at: now };
      markProfile.run(now, row.id);
      cleanupStmt.run('profile_facts', row.id, 'reject', pollution.reason || 'recall_pollution', JSON.stringify(row), JSON.stringify(next), now);
    }
  }
  const markJournal = db.prepare(`UPDATE journal_entries SET status = 'unsafe', safety = ? WHERE id = ?`);
  for (const row of db.prepare(`SELECT * FROM journal_entries WHERE status = 'active'`).all()) {
    const pollution = classifyRecallPollution(`${row.user_text}\n${row.assistant_text}`, { allowBenignContext: false });
    if (!pollution.polluted) continue;
    findings.journalEntries.push({ id: row.id, userId: row.user_id, day: row.day, reason: pollution.reason });
    if (options.apply === true) {
      const reason = pollution.reason || 'recall_pollution';
      const next = { ...row, status: 'unsafe', safety: reason };
      markJournal.run(reason, row.id);
      cleanupStmt.run('journal_entries', row.id, 'mark_unsafe', reason, JSON.stringify(row), JSON.stringify(next), now);
    }
  }
  const markRollup = db.prepare(`UPDATE journal_rollups SET status = 'archived' WHERE id = ?`);
  for (const row of db.prepare(`SELECT * FROM journal_rollups WHERE status = 'active'`).all()) {
    const pollution = classifyRecallPollution(row.text, { allowBenignContext: true });
    if (!pollution.polluted) continue;
    findings.journalRollups.push({ id: row.id, userId: row.user_id, level: row.level, day: row.day || row.end_day || row.start_day, reason: pollution.reason });
    if (options.apply === true) {
      const next = { ...row, status: 'archived' };
      markRollup.run(row.id);
      cleanupStmt.run('journal_rollups', row.id, 'archive', pollution.reason || 'recall_pollution', JSON.stringify(row), JSON.stringify(next), now);
    }
  }
  return { ok: true, findings };
}

function auditProfile(userId = '') {
  const projection = loadProfileProjection();
  const profile = projection.users?.[userId] || {};
  const identities = Array.isArray(profile.strictProfile?.identities) ? profile.strictProfile.identities : [];
  return identities
    .filter((text) => isNoisyIdentityText(text))
    .map((text) => ({
      type: 'profile_identity',
      userId,
      reason: 'noisy_identity',
      text
    }));
}

function writeQuarantine(userId = '', findings = []) {
  const dir = getUserJournalDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'memory_pollution_quarantine.json');
  const current = safeReadJson(filePath, { version: 1, updatedAt: 0, findings: [] });
  const existing = Array.isArray(current.findings) ? current.findings : [];
  atomicWriteJson(filePath, {
    version: 1,
    updatedAt: Date.now(),
    userId,
    mode: 'quarantine_markers_only',
    findings: existing.concat(findings)
  });
  return filePath;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.user && !args.scrub) {
    console.error('Usage: node scripts/audit-memory-pollution.js --user <id> [--apply] [--scrub] [--root <path>]');
    process.exit(1);
  }
  const userId = args.user ? (toSafeJournalPathSegment(args.user) ? String(args.user).trim() : '') : '';
  if (args.user && !userId) {
    console.error('Invalid --user');
    process.exit(1);
  }

  const findings = userId ? auditJournal(userId).concat(auditProfile(userId)) : [];
  const result = {
    ok: true,
    apply: args.apply,
    scrub: args.scrub,
    dataDir: config.DATA_DIR,
    userId,
    findings
  };
  if (args.apply) {
    if (userId) result.quarantineFile = writeQuarantine(userId, findings);
  }
  if (args.scrub) {
    result.fileScrub = scrubFiles(args);
    result.profileJournalDbScrub = scrubProfileJournalDb(args);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  auditJournal,
  auditProfile,
  parseArgs,
  scrubFiles,
  scrubProfileJournalDb,
  scrubTextFile,
  writeQuarantine
};

#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const config = require('../config');
const {
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

function parseArgs(argv = []) {
  const out = { user: '', apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (arg === '--apply') out.apply = true;
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
      }
    });
  }
  return findings;
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
  if (!args.user) {
    console.error('Usage: node scripts/audit-memory-pollution.js --user <id> [--apply]');
    process.exit(1);
  }
  const userId = toSafeJournalPathSegment(args.user) ? String(args.user).trim() : '';
  if (!userId) {
    console.error('Invalid --user');
    process.exit(1);
  }

  const findings = auditJournal(userId).concat(auditProfile(userId));
  const result = {
    ok: true,
    apply: args.apply,
    dataDir: config.DATA_DIR,
    userId,
    findings
  };
  if (args.apply) {
    result.quarantineFile = writeQuarantine(userId, findings);
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
  writeQuarantine
};

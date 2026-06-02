#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const config = require('../config');
const { loadMemoryNodes, loadProfileProjection, loadEpisodeProjection } = require('../utils/memory-v3/storage');
const { parseJournalEntries } = require('../utils/dailyJournal/text');
const { readJsonLines } = require('../utils/dailyJournal/jsonLines');
const {
  upsertJournalEntry,
  upsertJournalRollup,
  upsertProfileFact,
  getDiagnostics
} = require('../utils/profileJournalDb');

function text(value = '') {
  return String(value || '').trim();
}

function parseArgs(argv = process.argv.slice(2)) {
  return {
    apply: argv.includes('--apply'),
    limitUsers: Number(argv.find((item) => String(item).startsWith('--limit-users='))?.split('=')[1] || 0) || 0
  };
}

function safeReadText(filePath = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function safeReadJsonLines(filePath = '') {
  try {
    return readJsonLines(filePath);
  } catch (_) {
    return [];
  }
}

function maybeWriteProfileFact(fact, options, counters) {
  counters.profileFacts += 1;
  if (!options.apply) return;
  const result = upsertProfileFact(fact);
  if (result.ok) counters.profileFactsWritten += 1;
}

function migrateMemoryNodes(options, counters) {
  const nodes = loadMemoryNodes();
  for (const node of nodes) {
    maybeWriteProfileFact({
      ...node,
      value: node.text,
      type: node.type || node.memoryKind,
      fieldKey: node.fieldKey || node.semanticSlot,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt
    }, options, counters);
  }
}

function projectionFieldEntries(userId, tier, field, values = []) {
  const typeByField = {
    identities: 'identity',
    personality_traits: 'personality',
    hobbies: 'hobby',
    likes: 'like',
    dislikes: 'dislike',
    goals: 'goal',
    boundaries: 'boundary',
    single_hit_preferences: 'like',
    single_hit_traits: 'personality',
    recent_topics: 'topic'
  };
  const fieldKeyByField = {
    identities: 'identity',
    personality_traits: 'personality',
    hobbies: 'hobby',
    likes: 'preference_like',
    dislikes: 'preference_dislike',
    goals: 'goal',
    boundaries: 'boundary',
    single_hit_preferences: 'preference_like',
    single_hit_traits: 'personality',
    recent_topics: 'topic'
  };
  return (Array.isArray(values) ? values : []).map((value, index) => ({
    id: `projection:${userId}:${tier}:${field}:${index}:${Buffer.from(String(value || '')).toString('base64url').slice(0, 32)}`,
    userId,
    type: typeByField[field] || 'fact',
    fieldKey: fieldKeyByField[field] || 'fact',
    value,
    status: tier === 'strictProfile' ? 'active' : 'candidate',
    confidence: tier === 'strictProfile' ? 0.9 : 0.72,
    sourceKind: 'projection_migration',
    evidenceCount: tier === 'strictProfile' ? 2 : 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }));
}

function migrateProfileProjection(options, counters) {
  const projection = loadProfileProjection();
  const users = Object.entries(projection.users || {});
  const limited = options.limitUsers > 0 ? users.slice(0, options.limitUsers) : users;
  for (const [userId, profile] of limited) {
    const strict = profile?.strictProfile || {};
    const weak = profile?.weakProfile || {};
    for (const [field, values] of Object.entries(strict)) {
      for (const fact of projectionFieldEntries(userId, 'strictProfile', field, values)) {
        maybeWriteProfileFact(fact, options, counters);
      }
    }
    for (const [field, values] of Object.entries(weak)) {
      for (const fact of projectionFieldEntries(userId, 'weakProfile', field, values)) {
        maybeWriteProfileFact(fact, options, counters);
      }
    }
    const persona = profile?.personaCore || {};
    for (const [fieldKey, value] of [
      ['persona_summary_support', persona.summary],
      ['persona_impression_support', persona.impression],
      ['style_pattern', persona.replyStyle],
      ['relationship_tone', persona.relationshipTone],
      ['relationship_reply_style', persona.relationshipStyle]
    ]) {
      if (!text(value)) continue;
      maybeWriteProfileFact({
        id: `projection:${userId}:persona:${fieldKey}`,
        userId,
        type: fieldKey.includes('summary') ? 'summary' : fieldKey.includes('impression') ? 'impression' : 'fact',
        fieldKey,
        value,
        status: 'active',
        confidence: 0.86,
        sourceKind: 'projection_migration',
        evidenceCount: 2,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }, options, counters);
    }
  }
}

function maybeWriteJournalEntry(entry, options, counters) {
  counters.journalEntries += 1;
  if (!options.apply) return;
  const result = upsertJournalEntry(entry);
  if (result.ok) counters.journalEntriesWritten += 1;
}

function maybeWriteRollup(rollup, options, counters) {
  counters.journalRollups += 1;
  if (!options.apply) return;
  const result = upsertJournalRollup(rollup);
  if (result.ok) counters.journalRollupsWritten += 1;
}

function migrateEpisodeProjection(options, counters) {
  const projection = loadEpisodeProjection();
  for (const [userId, bucket] of Object.entries(projection.users || {})) {
    for (const item of Array.isArray(bucket?.items) ? bucket.items : []) {
      maybeWriteRollup({
        id: item.id ? `episode:${item.id}` : '',
        userId,
        level: item.rollupLevel || item.type || 'daily',
        day: item.episodeDay,
        startDay: item.startDay,
        endDay: item.endDay,
        text: item.text,
        status: item.notRecallable ? 'archived' : 'active',
        sourceEventIds: [item.id].filter(Boolean),
        quality: {
          source: item.source,
          sourceKind: item.sourceKind,
          textKind: item.textKind,
          sourceFile: item.sourceFile
        }
      }, options, counters);
    }
  }
}

function migrateJournalUserDir(userId, dirPath, options, counters) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const filePath = path.join(dirPath, name);
    const journalMatch = name.match(/^(\d{4}-\d{2}-\d{2})\.journal\.md$/i);
    if (journalMatch) {
      const day = journalMatch[1];
      const journalEntries = parseJournalEntries(safeReadText(filePath));
      const sidecars = safeReadJsonLines(path.join(dirPath, `${day}.entries.jsonl`));
      for (const [index, item] of journalEntries.entries()) {
        const sidecar = sidecars[index] || {};
        maybeWriteJournalEntry({
          userId,
          day,
          ts: sidecar.ts || `${day}T00:00:${String(index).padStart(2, '0')}.000Z`,
          sessionKey: sidecar.sessionKey,
          turnId: sidecar.turnId,
          userText: item.user,
          assistantText: item.assistant,
          safety: sidecar.unsafeReason || 'safe',
          status: sidecar.unsafe || sidecar.journalWriteSkipped ? 'unsafe' : 'active'
        }, options, counters);
      }
      continue;
    }
    const summaryMatch = name.match(/^(\d{4}-\d{2}-\d{2})\.summary\.md$/i);
    if (summaryMatch) {
      const day = summaryMatch[1];
      maybeWriteRollup({
        id: `summary:${userId}:${day}`,
        userId,
        level: 'daily',
        day,
        startDay: day,
        endDay: day,
        text: safeReadText(filePath),
        status: 'active',
        quality: { sourceFile: filePath }
      }, options, counters);
    }
  }

  const fourDayDir = path.join(dirPath, 'rollups', '4day');
  if (fs.existsSync(fourDayDir)) {
    for (const name of fs.readdirSync(fourDayDir)) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})__(\d{4}-\d{2}-\d{2})\.rollup\.md$/i);
      if (!match) continue;
      const filePath = path.join(fourDayDir, name);
      maybeWriteRollup({
        id: `4day:${userId}:${match[1]}:${match[2]}`,
        userId,
        level: '4day',
        day: match[2],
        startDay: match[1],
        endDay: match[2],
        text: safeReadText(filePath),
        status: 'active',
        quality: { sourceFile: filePath }
      }, options, counters);
    }
  }

  const monthlyDir = path.join(dirPath, 'rollups', 'monthly');
  if (fs.existsSync(monthlyDir)) {
    for (const name of fs.readdirSync(monthlyDir)) {
      const match = name.match(/^(\d{4}-\d{2})__(.+)\.rollup\.md$/i);
      if (!match) continue;
      const filePath = path.join(monthlyDir, name);
      maybeWriteRollup({
        id: `monthly:${userId}:${match[1]}:${match[2]}`,
        userId,
        level: 'monthly',
        day: `${match[1]}-01`,
        startDay: `${match[1]}-01`,
        endDay: `${match[1]}-31`,
        text: safeReadText(filePath),
        status: 'active',
        quality: { sourceFile: filePath }
      }, options, counters);
    }
  }
}

function migrateJournalFiles(options, counters) {
  const root = config.DAILY_JOURNAL_DIR;
  if (!root || !fs.existsSync(root)) return;
  const users = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const limited = options.limitUsers > 0 ? users.slice(0, options.limitUsers) : users;
  for (const entry of limited) {
    migrateJournalUserDir(entry.name, path.join(root, entry.name), options, counters);
  }
}

function runMigration(options = {}) {
  const counters = {
    applied: options.apply === true,
    profileFacts: 0,
    profileFactsWritten: 0,
    journalEntries: 0,
    journalEntriesWritten: 0,
    journalRollups: 0,
    journalRollupsWritten: 0
  };
  migrateMemoryNodes(options, counters);
  migrateProfileProjection(options, counters);
  migrateEpisodeProjection(options, counters);
  migrateJournalFiles(options, counters);
  return {
    ok: true,
    ...counters,
    diagnostics: options.apply ? getDiagnostics({ limit: 10 }) : null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runMigration(args);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error?.message || String(error)
    }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  runMigration
};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const {
  appendMemoryEvent,
  loadMemoryEvents
} = require('./events');
const { materializeMemoryViews } = require('./materializer');
const { memories, favorites } = require('../memory');
const { getMemoryItems } = require('../vectorMemory');
const { loadBridgeStore } = require('../shortTermBridgeMemory');
const { getSessionContextSummaryStoreSnapshot } = require('../sessionContextSummaryStore');
const {
  listUserJournalDays,
  listFourDayRollups,
  listMonthlyRollups
} = require('../dailyJournal');
const { loadMemoryScopeIndex } = require('../memoryScopeIndex');

function stableLegacyMigrationIdentity(item = {}) {
  const payload = {
    oldItemId: String(item.id || item.nodeId || '').trim(),
    userId: String(item.userId || '').trim(),
    scopeType: String(item.scopeType || 'personal').trim().toLowerCase() || 'personal',
    groupId: String(item.groupId || '').trim(),
    channelId: String(item.channelId || '').trim(),
    sessionId: String(item.sessionId || '').trim(),
    sessionKey: String(item.sessionKey || '').trim(),
    fieldKey: String(item.fieldKey || item.semanticSlot || item.type || '').trim().toLowerCase(),
    canonicalKey: String(item.canonicalKey || item.canonicalText || item.text || '').trim().toLowerCase()
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  return `m3_legacy_${digest.slice(0, 28)}`;
}

function toLegacyVectorMigrationEvent(item = {}) {
  const id = stableLegacyMigrationIdentity(item);
  const memoryKind = item.meta?.memoryKind || item.memoryKind || item.type;
  const fieldKey = item.fieldKey || item.semanticSlot || item.type;
  return {
    id,
    dedupeKey: id,
    type: item.status === 'candidate' ? 'memory_candidate_extracted' : 'migration_bootstrap',
    ts: Number(item.updatedAt || item.createdAt || 1) || 1,
    userId: item.userId,
    groupId: item.groupId,
    channelId: item.channelId,
    sessionId: item.sessionId,
    sessionKey: item.sessionKey,
    routePolicyKey: item.routePolicyKey,
    topRouteType: item.topRouteType,
    scopeType: item.scopeType,
    source: item.source || 'memory_items',
    sourceKind: item.sourceKind || 'migration',
    status: item.status || 'active',
    confidence: item.confidence,
    importance: item.importance,
    evidenceCount: item.evidenceCount,
    taskType: item.taskType,
    toolName: item.toolName,
    agentName: item.agentName,
    memoryKind,
    semanticSlot: fieldKey,
    conflictKey: item.conflictKey,
    canonicalKey: item.canonicalKey || item.canonicalText,
    text: item.text,
    participants: item.participants,
    entities: item.entities,
    relations: item.relations,
    payload: {
      type: item.type,
      fieldKey,
      memoryKind,
      migrationIdentity: id,
      supersededBy: item.supersededBy || item.meta?.supersededBy || ''
    }
  };
}

function collectLegacyVectorMigrationEvents(options = {}) {
  if (Array.isArray(options.events)) {
    return options.events.slice().sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }
  const items = Array.isArray(options.items)
    ? options.items
    : (options.getMemoryItems || getMemoryItems)();
  const byId = new Map();
  for (const item of items) {
    const event = toLegacyVectorMigrationEvent(item);
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id));
}

async function migrateLegacyVectorMemoryToV3(options = {}) {
  const events = collectLegacyVectorMigrationEvents(options);
  const loadEvents = options.loadEvents || loadMemoryEvents;
  const appendEvent = options.appendEvent || appendMemoryEvent;
  const existingIds = new Set(loadEvents().map((event) => String(event?.id || '').trim()).filter(Boolean));
  const pending = events.filter((event) => !existingIds.has(event.id));
  for (const event of pending) await appendEvent(event);
  const materialized = options.skipMaterialize === true
    ? { materialized: null }
    : materializeMemoryV3Views({ force: true, source: 'legacy_vector_convergence_import' });
  return {
    ok: true,
    mode: 'convergence',
    candidateCount: events.length,
    importedCount: pending.length,
    stableIds: events.map((event) => event.id),
    materialized: materialized.materialized
  };
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function isPersonalUserId(userId = '') {
  const value = String(userId || '').trim();
  if (!value) return false;
  if (value.startsWith('group:')) return false;
  if (value.includes(':group:')) return false;
  if (value.includes(':channel:')) return false;
  return true;
}

function hasExistingLegacyMigrationEvents() {
  return loadMemoryEvents().some((event) => {
    const type = String(event?.type || '').trim().toLowerCase();
    const source = String(event?.source || '').trim().toLowerCase();
    const sourceKind = String(event?.sourceKind || '').trim().toLowerCase();
    return type === 'migration_bootstrap'
      && (sourceKind === 'migration' || source === 'legacy_memories' || source === 'memory_scope_index');
  });
}

function materializeMemoryV3Views(options = {}) {
  const result = materializeMemoryViews({
    force: options.force !== false,
    source: options.source || 'memory_v3_materialize'
  });
  return {
    ok: result?.ok === true && result?.deferred !== true,
    mode: 'materialize',
    deferred: result?.deferred === true,
    reason: result?.reason || '',
    materialized: result?.stats || null
  };
}

function backupLegacyFiles() {
  const backupDir = path.join(config.DATA_DIR, `memory-v3-backup-${Date.now()}`);
  ensureDir(backupDir);
  const files = [
    config.MEMORY_FILE,
    path.join(config.DATA_DIR, 'memory_items.json'),
    config.SHORT_TERM_BRIDGE_FILE,
    config.SESSION_CONTEXT_SUMMARY_FILE,
    config.MEMORY_SCOPE_INDEX_FILE,
    config.DAILY_JOURNAL_DIR
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const target = path.join(backupDir, path.basename(file));
    const stat = fs.statSync(file);
    if (stat.isDirectory()) fs.cpSync(file, target, { recursive: true });
    else fs.copyFileSync(file, target);
  }
  return backupDir;
}

async function migrateLegacyMemoryToV3(options = {}) {
  if (options.convergence === true) return migrateLegacyVectorMemoryToV3(options);

  if (options.forceImport !== true && hasExistingLegacyMigrationEvents()) {
    const materialized = materializeMemoryV3Views({
      force: true,
      source: 'legacy_migration_existing_events'
    });
    return {
      ok: materialized.ok,
      skipped: true,
      reason: 'legacy_migration_events_exist',
      backupDir: '',
      materialized: materialized.materialized,
      favoritesUsers: Object.keys(favorites || {}).length
    };
  }

  const backupDir = backupLegacyFiles();
  const importedUsers = new Set();

  for (const [userId, memory] of Object.entries(memories || {})) {
    if (!isPersonalUserId(userId)) continue;
    importedUsers.add(userId);
    const profile = memory?.profile || {};
    for (const fact of Array.isArray(memory?.facts) ? memory.facts : []) {
      await appendMemoryEvent({ type: 'migration_bootstrap', userId, scopeType: 'personal', source: 'legacy_memories', sourceKind: 'migration', status: 'active', memoryKind: 'fact', semanticSlot: 'fact', text: fact, payload: { type: 'fact' } });
    }
    for (const [field, type] of [['identities', 'identity'], ['personality_traits', 'personality'], ['hobbies', 'hobby'], ['likes', 'like'], ['dislikes', 'dislike'], ['goals', 'goal'], ['recent_topics', 'topic']]) {
      for (const item of Array.isArray(profile?.[field]) ? profile[field] : []) {
        await appendMemoryEvent({ type: 'migration_bootstrap', userId, scopeType: 'personal', source: 'legacy_memories', sourceKind: 'migration', status: 'active', memoryKind: type, semanticSlot: type, text: item, payload: { type } });
      }
    }
    if (memory?.summary) await appendMemoryEvent({ type: 'migration_bootstrap', userId, scopeType: 'personal', source: 'legacy_memories', sourceKind: 'migration', status: 'active', memoryKind: 'summary', semanticSlot: 'summary', text: memory.summary, payload: { type: 'summary' } });
    if (memory?.impression) await appendMemoryEvent({ type: 'migration_bootstrap', userId, scopeType: 'personal', source: 'legacy_memories', sourceKind: 'migration', status: 'active', memoryKind: 'impression', semanticSlot: 'impression', text: memory.impression, payload: { type: 'impression' } });
  }

  for (const item of getMemoryItems()) {
    await appendMemoryEvent({
      type: item.status === 'candidate' ? 'memory_candidate_extracted' : 'migration_bootstrap',
      userId: item.userId,
      groupId: item.groupId,
      channelId: item.channelId,
      sessionId: item.sessionId,
      routePolicyKey: item.routePolicyKey,
      topRouteType: item.topRouteType,
      scopeType: item.scopeType,
      source: item.source || 'memory_items',
      sourceKind: item.sourceKind || 'migration',
      status: item.status || 'active',
      confidence: item.confidence,
      importance: item.importance,
      evidenceCount: item.evidenceCount,
      taskType: item.taskType,
      toolName: item.toolName,
      agentName: item.agentName,
      memoryKind: item.meta?.memoryKind || item.type,
      semanticSlot: item.type,
      conflictKey: item.conflictKey,
      canonicalKey: item.canonicalText,
      text: item.text,
      participants: item.participants,
      entities: item.entities,
      relations: item.relations,
      payload: { type: item.type, memoryKind: item.meta?.memoryKind || item.type }
    });
  }

  const bridge = loadBridgeStore();
  for (const [sessionKey, session] of Object.entries(bridge.sessions || {})) {
    await appendMemoryEvent({
      type: 'session_checkpoint',
      userId: session.userId,
      sessionKey,
      groupId: session.scope?.groupId,
      channelId: session.scope?.channelId,
      sessionId: session.scope?.sessionId,
      scopeType: 'session',
      source: 'short_term_bridge',
      sourceKind: 'migration',
      payload: {
        snapshotType: session.snapshotType,
        activeTopic: session.shortTermState?.activeTopic || '',
        summary: session.shortTermState?.summary || '',
        carryOverUserTurn: session.shortTermState?.carryOverUserTurn || '',
        openLoops: session.shortTermState?.openLoops || [],
        assistantCommitments: session.shortTermState?.assistantCommitments || [],
        userConstraints: session.shortTermState?.userConstraints || [],
        recentMessages: session.recentMessages || []
      },
      ts: session.updatedAt
    });
  }

  const summaries = getSessionContextSummaryStoreSnapshot();
  for (const [sessionKey, items] of Object.entries(summaries.sessions || {})) {
    for (const item of Array.isArray(items) ? items : []) {
      await appendMemoryEvent({
        type: 'session_checkpoint',
        userId: item.userId,
        sessionKey,
        groupId: item.groupId,
        scopeType: 'session',
        source: 'session_summary',
        sourceKind: 'migration',
        payload: { snapshotType: 'summary', summary: item.summary },
        ts: item.createdAt
      });
    }
  }

  const scopeIndex = loadMemoryScopeIndex();
  for (const [userId, entry] of Object.entries(scopeIndex.users || {})) {
    if (!isPersonalUserId(userId)) continue;
    importedUsers.add(userId);
    for (const group of Array.isArray(entry.groups) ? entry.groups : []) {
      await appendMemoryEvent({ type: 'migration_bootstrap', userId, groupId: group.groupId, scopeType: 'personal', source: 'memory_scope_index', sourceKind: 'migration', payload: {} });
    }
    for (const channel of Array.isArray(entry.channels) ? entry.channels : []) {
      await appendMemoryEvent({ type: 'migration_bootstrap', userId, channelId: channel.channelId, scopeType: 'personal', source: 'memory_scope_index', sourceKind: 'migration', payload: {} });
    }
  }

  for (const userId of importedUsers) {
    if (!isPersonalUserId(userId)) continue;
    for (const day of listUserJournalDays(userId)) {
      await appendMemoryEvent({ type: 'episode_rollup_generated', userId, scopeType: 'personal', source: 'daily_journal', sourceKind: 'migration', memoryKind: 'episode', text: `daily journal day ${day}`, payload: { rollupLevel: 'daily', episodeDay: day } });
    }
    for (const item of listFourDayRollups(userId)) {
      await appendMemoryEvent({ type: 'episode_rollup_generated', userId, scopeType: 'personal', source: 'daily_journal', sourceKind: 'migration', memoryKind: 'episode', text: item.text, payload: { rollupLevel: '4day', startDay: item.startDay, endDay: item.endDay, yearMonth: item.yearMonth } });
    }
    for (const item of listMonthlyRollups(userId)) {
      await appendMemoryEvent({ type: 'episode_rollup_generated', userId, scopeType: 'personal', source: 'daily_journal', sourceKind: 'migration', memoryKind: 'episode', text: item.text, payload: { rollupLevel: 'monthly', yearMonth: item.yearMonth, part: item.part } });
    }
  }

  const materialized = materializeMemoryV3Views({
    force: true,
    source: 'legacy_migration_import'
  });
  return {
    ok: true,
    backupDir,
    materialized: materialized.materialized,
    favoritesUsers: Object.keys(favorites || {}).length
  };
}

module.exports = {
  collectLegacyVectorMigrationEvents,
  migrateLegacyVectorMemoryToV3,
  stableLegacyMigrationIdentity,
  toLegacyVectorMigrationEvent,
  materializeMemoryV3Views,
  migrateLegacyMemoryToV3
};

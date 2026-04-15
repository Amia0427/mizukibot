const fs = require('fs');
const path = require('path');
const config = require('../config');
const {
  appendMemoryEvent,
  materializeMemoryViews
} = require('../utils/memory-v3');
const { memories, favorites } = require('../utils/memory');
const { getMemoryItems } = require('../utils/vectorMemory');
const { loadBridgeStore } = require('../utils/shortTermBridgeMemory');
const { getSessionContextSummaryStoreSnapshot } = require('../utils/sessionContextSummaryStore');
const {
  listUserJournalDays,
  listFourDayRollups,
  listMonthlyRollups
} = require('../utils/dailyJournal');
const { loadMemoryScopeIndex } = require('../utils/memoryScopeIndex');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
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
    if (stat.isDirectory()) {
      fs.cpSync(file, target, { recursive: true });
    } else {
      fs.copyFileSync(file, target);
    }
  }
  return backupDir;
}

async function main() {
  const backupDir = backupLegacyFiles();
  const importedUsers = new Set();

  for (const [userId, memory] of Object.entries(memories || {})) {
    importedUsers.add(userId);
    const profile = memory?.profile || {};
    for (const fact of Array.isArray(memory?.facts) ? memory.facts : []) {
      await appendMemoryEvent({
        type: 'migration_bootstrap',
        userId,
        scopeType: 'personal',
        source: 'legacy_memories',
        sourceKind: 'migration',
        status: 'active',
        memoryKind: 'fact',
        semanticSlot: 'fact',
        text: fact,
        payload: { type: 'fact' }
      });
    }
    for (const [field, type] of [
      ['identities', 'identity'],
      ['personality_traits', 'personality'],
      ['hobbies', 'hobby'],
      ['likes', 'like'],
      ['dislikes', 'dislike'],
      ['goals', 'goal'],
      ['recent_topics', 'topic']
    ]) {
      for (const item of Array.isArray(profile?.[field]) ? profile[field] : []) {
        await appendMemoryEvent({
          type: 'migration_bootstrap',
          userId,
          scopeType: 'personal',
          source: 'legacy_memories',
          sourceKind: 'migration',
          status: 'active',
          memoryKind: type,
          semanticSlot: type,
          text: item,
          payload: { type }
        });
      }
    }
    if (memory?.summary) {
      await appendMemoryEvent({
        type: 'migration_bootstrap',
        userId,
        scopeType: 'personal',
        source: 'legacy_memories',
        sourceKind: 'migration',
        status: 'active',
        memoryKind: 'summary',
        semanticSlot: 'summary',
        text: memory.summary,
        payload: { type: 'summary' }
      });
    }
    if (memory?.impression) {
      await appendMemoryEvent({
        type: 'migration_bootstrap',
        userId,
        scopeType: 'personal',
        source: 'legacy_memories',
        sourceKind: 'migration',
        status: 'active',
        memoryKind: 'impression',
        semanticSlot: 'impression',
        text: memory.impression,
        payload: { type: 'impression' }
      });
    }
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
      payload: {
        type: item.type,
        memoryKind: item.meta?.memoryKind || item.type
      }
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
        payload: {
          snapshotType: 'summary',
          summary: item.summary
        },
        ts: item.createdAt
      });
    }
  }

  const scopeIndex = loadMemoryScopeIndex();
  for (const [userId, entry] of Object.entries(scopeIndex.users || {})) {
    importedUsers.add(userId);
    for (const group of Array.isArray(entry.groups) ? entry.groups : []) {
      await appendMemoryEvent({
        type: 'migration_bootstrap',
        userId,
        groupId: group.groupId,
        scopeType: 'personal',
        source: 'memory_scope_index',
        sourceKind: 'migration',
        payload: {}
      });
    }
    for (const channel of Array.isArray(entry.channels) ? entry.channels : []) {
      await appendMemoryEvent({
        type: 'migration_bootstrap',
        userId,
        channelId: channel.channelId,
        scopeType: 'personal',
        source: 'memory_scope_index',
        sourceKind: 'migration',
        payload: {}
      });
    }
  }

  for (const userId of importedUsers) {
    for (const day of listUserJournalDays(userId)) {
      await appendMemoryEvent({
        type: 'episode_rollup_generated',
        userId,
        scopeType: 'personal',
        source: 'daily_journal',
        sourceKind: 'migration',
        memoryKind: 'episode',
        text: `daily journal day ${day}`,
        payload: {
          rollupLevel: 'daily',
          episodeDay: day
        }
      });
    }
    for (const item of listFourDayRollups(userId)) {
      await appendMemoryEvent({
        type: 'episode_rollup_generated',
        userId,
        scopeType: 'personal',
        source: 'daily_journal',
        sourceKind: 'migration',
        memoryKind: 'episode',
        text: item.text,
        payload: {
          rollupLevel: '4day',
          startDay: item.startDay,
          endDay: item.endDay,
          yearMonth: item.yearMonth
        }
      });
    }
    for (const item of listMonthlyRollups(userId)) {
      await appendMemoryEvent({
        type: 'episode_rollup_generated',
        userId,
        scopeType: 'personal',
        source: 'daily_journal',
        sourceKind: 'migration',
        memoryKind: 'episode',
        text: item.text,
        payload: {
          rollupLevel: 'monthly',
          yearMonth: item.yearMonth,
          part: item.part
        }
      });
    }
  }

  const materialized = materializeMemoryViews();
  console.log(JSON.stringify({
    ok: true,
    backupDir,
    materialized: materialized.stats,
    favoritesUsers: Object.keys(favorites || {}).length
  }, null, 2));
}

main().catch((error) => {
  console.error('[migrate-memory-v3] failed:', error?.stack || error?.message || error);
  process.exit(1);
});

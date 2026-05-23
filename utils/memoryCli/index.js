const config = require('../../config');
const {
  rememberExplicitMemory
} = require('../vectorMemory');
const {
  getAccessibleGroupIdsForUser
} = require('../memoryScopeIndex');
const {
  ensureSnapshot,
  searchMemoryCliFast,
  openMemoryCliFast
} = require('../memory-v3/cliSearchRuntime');
const {
  queryLocalKnowledge,
  readNotebookDoc
} = require('../localKnowledge');
const {
  sanitizeText,
  parseMemoryCliCommand,
  prepareMemoryCliCommand
} = require('./commandParser');
const { mergeImageSearchIntoPayload } = require('./imageRecall');
const {
  openJournalByRef,
  parseJournalRawRef
} = require('./journalCandidates');
const {
  getUnifiedMemoryStats,
  listUnifiedMemorySources,
  openUnifiedMemory,
  reviewMemories
} = require('./openSupport');
const {
  runLegacyMemorySearch,
  searchUnifiedMemory
} = require('./searchRuntime');
const {
  explainProfileInjection,
  listStaleProfileMemories,
  reviewProfileMemories
} = require('./profileDiagnostics');

function preloadMemoryCli(options = {}) {
  return ensureSnapshot(options);
}

async function runMemoryCli(commandText = '', context = {}) {
  const startedAt = Date.now();
  const prepared = prepareMemoryCliCommand(commandText);
  if (!prepared.ok || !prepared.parsed) {
    if (config.ENABLE_DEBUG_LOG) {
      console.log('[memory_cli] command invalid', {
        rawPreview: String(prepared.rawCommandText || '').slice(0, 180),
        invalidReason: prepared.invalidReason
      });
    }
    return {
      ok: false,
      command: '',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      invalidReason: prepared.invalidReason,
      results: []
    };
  }

  if (config.ENABLE_DEBUG_LOG && prepared.repairApplied) {
    console.log('[memory_cli] command normalized', {
      rawPreview: String(prepared.rawCommandText || '').slice(0, 180),
      normalizedPreview: String(prepared.normalizedCommandText || '').slice(0, 180),
      repairStrategy: prepared.repairStrategy
    });
  }

  const parsed = prepared.parsed;
  const userId = sanitizeText(context.userId);
  let payload = null;

  if (parsed.commandName === 'search') {
    if (parsed.source === 'image' || String(config.MEMORY_CLI_SEARCH_ENGINE || 'fast').trim().toLowerCase() === 'legacy') {
      payload = await runLegacyMemorySearch(parsed, prepared, context);
    } else {
      try {
        const fastSearch = await searchMemoryCliFast(parsed.query, {
          source: parsed.source,
          limit: parsed.limit
        }, {
          ...context,
          userId,
          groupIds: getAccessibleGroupIdsForUser(userId)
        });
        payload = {
          ok: true,
          command: 'search',
          rawCommandText: prepared.rawCommandText,
          normalizedCommandText: prepared.normalizedCommandText,
          repairApplied: prepared.repairApplied,
          repairStrategy: prepared.repairStrategy,
          count: fastSearch.results.length,
          results: fastSearch.results,
          digest: fastSearch.digest,
          sourceCoverage: fastSearch.sourceCoverage,
          queryFacet: fastSearch.queryFacet,
          candidateCounts: fastSearch.candidateCounts,
          diagnostics: fastSearch.diagnostics || {},
          fallbackUsed: fastSearch.fallbackUsed,
          outputChars: fastSearch.outputChars,
          recentUsed: fastSearch.recentUsed,
          droppedResultCount: fastSearch.droppedResultCount
        };
        if (parsed.source === 'all') {
          payload = mergeImageSearchIntoPayload(payload, parsed.query, {
            ...context,
            userId,
            groupIds: getAccessibleGroupIdsForUser(userId)
          }, parsed.limit);
        }
      } catch (error) {
        if (config.ENABLE_DEBUG_LOG) {
          console.warn('[memory_cli_fast] search fallback to legacy:', error?.message || error);
        }
        payload = await runLegacyMemorySearch(parsed, prepared, context);
      }
    }
  }

  if (!payload && parsed.commandName === 'remember') {
    const userId = sanitizeText(context.userId);
    const groupId = sanitizeText(context.groupId);
    const scope = parsed.scope === 'group' && groupId ? 'group' : 'personal';
    const id = rememberExplicitMemory(userId, parsed.text, {
      scopeType: scope,
      groupId: scope === 'group' ? groupId : '',
      sessionId: sanitizeText(context.sessionId),
      routePolicyKey: sanitizeText(context.routePolicyKey),
      topRouteType: sanitizeText(context.topRouteType),
      agentName: sanitizeText(context.agentName),
      toolName: sanitizeText(context.toolName),
      channelId: sanitizeText(context.channelId),
      participants: Array.isArray(context.participants) ? context.participants : []
    });
    payload = {
      ok: Boolean(id),
      command: 'remember',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      id: id || null,
      scope,
      text: parsed.text
    };
  }

  if (!payload && parsed.commandName === 'review') {
    payload = {
      ...reviewMemories(context, parsed),
      command: 'review',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy
    };
  }

  if (!payload && parsed.commandName === 'profile') {
    if (parsed.action === 'review') {
      payload = reviewProfileMemories(context, parsed);
    } else if (parsed.action === 'stale') {
      payload = listStaleProfileMemories(context, parsed);
    } else if (parsed.action === 'why-injected') {
      payload = explainProfileInjection(context, parsed);
    }
    if (payload) {
      payload = {
        ...payload,
        rawCommandText: prepared.rawCommandText,
        normalizedCommandText: prepared.normalizedCommandText,
        repairApplied: prepared.repairApplied,
        repairStrategy: prepared.repairStrategy
      };
    }
  }

  if (!payload && parsed.commandName === 'open') {
    let opened = null;
    if (String(config.MEMORY_CLI_SEARCH_ENGINE || 'fast').trim().toLowerCase() !== 'legacy') {
      try {
        opened = await openMemoryCliFast(parsed, context);
      } catch (error) {
        if (config.ENABLE_DEBUG_LOG) {
          console.warn('[memory_cli_fast] open fallback to legacy:', error?.message || error);
        }
      }
    }
    if (!opened && (parsed.source === 'notebook' || String(parsed.ref || '').startsWith('mc_ref:notebook:'))) {
      const refParts = String(parsed.ref || '').replace(/^mc_ref:notebook:/, '').split(':');
      const openedNotebook = readNotebookDoc({ userId }, {
        userId,
        docId: refParts[0] || parsed.id,
        chunkIndex: Number(refParts[1] || 0) || 0
      });
      if (openedNotebook?.ok) {
        opened = {
          source: 'notebook',
          id: refParts[0] || parsed.id,
          data: openedNotebook
        };
      }
    }
    if (!opened) {
      opened = openUnifiedMemory(parsed, parsed, context);
    }
    if (!opened && parseJournalRawRef(parsed.ref)) {
      const openedJournal = openJournalByRef(sanitizeText(context.userId), parsed.ref);
      if (openedJournal && openedJournal.data && typeof openedJournal.data === 'object') {
        opened = {
          source: 'journal',
          id: openedJournal.id,
          data: openedJournal.data
        };
      }
    }
    payload = {
      ok: Boolean(opened),
      command: 'open',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      source: opened ? opened.source : parsed.source,
      id: opened ? opened.id : parsed.id,
      data: opened ? opened.data : null
    };
  }

  if (!payload && parsed.commandName === 'ls') {
    payload = {
      ...listUnifiedMemorySources(context),
      command: 'ls',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy
    };
  }

  if (!payload && parsed.commandName === 'stats') {
    const localKnowledgeStats = await queryLocalKnowledge({
      userId,
      query: '',
      topK: 1,
      groupId: sanitizeText(context.groupId),
      sessionKey: sanitizeText(context.sessionKey)
    });
    payload = {
      ...getUnifiedMemoryStats(context),
      command: 'stats',
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      localKnowledge: localKnowledgeStats.diagnostics
    };
  }

  if (!payload) {
    payload = {
      ok: false,
      command: parsed.commandName,
      rawCommandText: prepared.rawCommandText,
      normalizedCommandText: prepared.normalizedCommandText,
      repairApplied: prepared.repairApplied,
      repairStrategy: prepared.repairStrategy,
      invalidReason: 'unsupported_command'
    };
  }

  if (config.ENABLE_DEBUG_LOG) {
    const topResult = Array.isArray(payload?.results) && payload.results.length > 0
      ? payload.results[0]
      : null;
    console.log('[memory_cli] command executed', {
      userId,
      route: `${String(context.topRouteType || '').trim() || 'unknown'}:${String(context.routePolicyKey || '').trim() || 'unknown'}`,
      commandName: parsed.commandName,
      source: parsed.source || '',
      hitCount: Number(payload?.count || payload?.results?.length || 0) || 0,
      topResultType: String(topResult?.type || '').trim(),
      topResultSource: String(topResult?.source || '').trim(),
      topResultRef: String(topResult?.ref || '').trim().slice(0, 160),
      durationMs: Date.now() - startedAt,
      truncated: Boolean(payload?.droppedResultCount)
    });
  }

  return payload;
}

module.exports = {
  parseMemoryCliCommand,
  prepareMemoryCliCommand,
  searchUnifiedMemory,
  openUnifiedMemory,
  listUnifiedMemorySources,
  getUnifiedMemoryStats,
  preloadMemoryCli,
  runMemoryCli
};

const assert = require('assert');

const {
  EXIT_CODES,
  SCHEMA_VERSION,
  buildAdminReplyEnvelope,
  parseMemoryOpsArgs,
  runMemoryOps,
  runMemoryOpsFromArgv
} = require('../scripts/diagnose-memory-ops');
const { createMessageAdminCoordinator, parseMemoryOpsPayload } = require('../core/messageAdminCommands');
const { createMessageRouteFlow } = require('../core/messageRouteFlow');
const { parseAdminCommand } = require('../core/router');

const calls = [];
const runners = {
  runDiagnostics: async (args) => {
    calls.push(['diagnose', args]);
    return {
      ok: true,
      lancedbDir: 'D:/tmp/lancedb',
      syncEnabled: true,
      coverage: { memory: { readyRatio: 0.5 }, worldbook: { readyRatio: 1 } },
      memory: { sourceRows: 2, ready: 1 },
      worldbook: { sourceRows: 1, ready: 1 },
      journal: {
        totals: {
          users: 1,
          days: 2,
          summaryDays: 1,
          segmentDays: 1,
          segments: 3,
          v3EpisodeEvents: 1,
          v3EpisodeItems: 1,
          embeddingReady: 1,
          embeddingPending: 1,
          embeddingFailed: 0
        },
        users: [{ userId: 'u1', days: 2, summaryDays: 1 }]
      },
      probe: {
        cases: 2,
        fallbackCounts: { empty_result: 1 },
        leakage: 0,
        sourceCoverage: { lexical: 2 }
      },
      healthGate: {
        canBackfill: false,
        mustReconcileFirst: true,
        nextSafeCommand: 'node scripts/repair-memory-vector-index.js --apply --compact'
      },
      recommendedActions: [{
        action: 'reconcile',
        command: 'node scripts/repair-memory-vector-index.js --apply --compact',
        required: true
      }]
    };
  },
  runBackfill: async (args) => {
    calls.push(['backfill', args]);
    return {
      ok: true,
      dryRun: args.dryRun,
      source: args.source,
      considered: 3,
      readyBefore: 1,
      embedded: 0,
      failed: 0,
      failureBreakdown: {},
      remaining: 3,
      results: [{ ok: true, considered: 3 }]
    };
  },
  loadCases: (limit, options = {}) => {
    calls.push(['loadCases', { limit, options }]);
    return [{
      id: 'case_1',
      userId: 'u1',
      groupId: 'g1',
      query: '记得我喜欢什么吗',
      facet: 'preference',
      expectedIds: []
    }];
  },
  runMode: async (mode, cases, options) => {
    calls.push(['recall', { mode, cases: cases.length, options }]);
    return {
      mode,
      cases: cases.length,
      judgedCases: 0,
      recallAt8: null,
      mrrAt8: null,
      leakage: 0,
      lifecycleLeakage: 0,
      categoryMismatches: 0,
      recentRecallMisses: 0,
      sourceCoverage: { personal: 1 },
      avgPromptTokenEstimate: 12,
      latency: { main: { p50Ms: 3, p95Ms: 5 } },
      details: [{ id: 'case_1', resultIds: ['node_1'] }]
    };
  },
  diagnoseMemosPlannerRecall: async (args) => {
    calls.push(['memos', args]);
    return {
      ok: true,
      enabled: true,
      serverName: 'memos-api-mcp',
      recallSource: 'knowledge_base',
      readOnly: true,
      configured: {
        knowledgebaseIdsCount: 1,
        kbFileIdsCount: 0,
        kbAliasCount: 1,
        queryMode: 'compact'
      },
      routeGate: { allowed: true, reason: 'external_kb_query' },
      discovery: {
        availableTools: ['search_memory', 'add_message'],
        kbToolName: '',
        searchToolName: 'search_memory',
        mutatingToolsDetected: true,
        mutatingToolNames: ['add_message'],
        error: ''
      },
      runtime: {
        cache: { size: 1, hits: 2, misses: 1 },
        circuit: { open: false, failures: 0, shortCircuits: 0 }
      }
    };
  },
  buildStorageOverlapSummary: async (args) => {
    calls.push(['storage-overlap', args]);
    return {
      ok: true,
      expectedIndexCopies: { count: 2, samples: [] },
      unexpectedVectorRows: { count: 1, rawJournalRows: 0, samples: [] },
      missingVectorRows: { count: 0, samples: [] },
      sqliteOnlyRows: { count: 3, expectedSourceOnlyJournalEntries: 1, samples: [] },
      vectorOnlyRows: { count: 1, samples: [] },
      alignment: { keys: ['nodeId', 'canonicalKeyHash', 'textHash', 'rollupId'] },
      recommendedAction: 'run_full_lancedb_reconcile'
    };
  }
};

module.exports = (async () => {
  const parsed = parseMemoryOpsArgs(['backfill', '--source', 'memory', '--limit', '7', '--retry-failed']);
  assert.strictEqual(parsed.mode, 'backfill');
  assert.strictEqual(parsed.source, 'memory');
  assert.strictEqual(parsed.limit, 7);
  assert.strictEqual(parsed.retryFailed, true);
  const parsedGate = parseMemoryOpsArgs(['recall', '--gate', '--min-recall-at8', '0.7', '--max-empty-result-rate', '0.4', '--max-no-visible-candidate-rate', '0.5', '--max-lifecycle-leakage', '0', '--max-category-mismatches', '0', '--max-recent-recall-misses', '0']);
  assert.strictEqual(parsedGate.gate, true);
  assert.strictEqual(parsedGate.minRecallAt8, 0.7);
  assert.strictEqual(parsedGate.maxEmptyResultRate, 0.4);
  assert.strictEqual(parsedGate.maxNoVisibleCandidateRate, 0.5);
  assert.strictEqual(parsedGate.maxLifecycleLeakage, 0);
  assert.strictEqual(parsedGate.maxCategoryMismatches, 0);
  assert.strictEqual(parsedGate.maxRecentRecallMisses, 0);
  const parsedAutoGold = parseMemoryOpsArgs(['lancedb-gate', '--auto-gold']);
  assert.strictEqual(parsedAutoGold.autoGold, true);
  const parsedMemos = parseMemoryOpsArgs(['memos', '--query', '世界观规则']);
  assert.strictEqual(parsedMemos.mode, 'memos');
  assert.strictEqual(parsedMemos.query, '世界观规则');
  assert.strictEqual(parseMemoryOpsArgs(['storage-overlap', '--limit', '3']).mode, 'storage-overlap');
  assert.strictEqual(parseMemoryOpsArgs(['overlap']).mode, 'storage-overlap');

  const diagnose = await runMemoryOps(parseMemoryOpsArgs(['diagnose', '--limit', '2']), { runners });
  assert.strictEqual(diagnose.schemaVersion, SCHEMA_VERSION);
  assert.strictEqual(diagnose.mode, 'diagnose');
  assert.strictEqual(diagnose.ok, true);
  assert.strictEqual(diagnose.exitCode, EXIT_CODES.ok);
  assert.ok(Object.prototype.hasOwnProperty.call(diagnose.summary, 'coverage'));
  assert.strictEqual(diagnose.summary.journal.totals.days, 2);
  assert.strictEqual(diagnose.summary.journal.totals.v3EpisodeEvents, 1);
  assert.strictEqual(diagnose.details.journal.totals.embeddingPending, 1);
  assert.strictEqual(diagnose.summary.fallback.fallbackCounts.empty_result, 1);
  assert.strictEqual(diagnose.summary.healthGate.mustReconcileFirst, true);
  assert.strictEqual(diagnose.summary.recommendedActions[0].action, 'reconcile');

  const backfill = await runMemoryOps(parseMemoryOpsArgs(['backfill', '--source', 'journal', '--limit', '4']), { runners });
  assert.strictEqual(backfill.mode, 'backfill');
  assert.strictEqual(backfill.summary.dryRun, true);
  assert.strictEqual(calls.find((entry) => entry[0] === 'backfill')[1].dryRun, true);
  assert.strictEqual(backfill.summary.embedded, 0);

  const memosHealth = await runMemoryOps(parseMemoryOpsArgs(['memos', '--query', '世界观规则']), { runners });
  assert.strictEqual(memosHealth.mode, 'memos');
  assert.strictEqual(memosHealth.ok, true);
  assert.strictEqual(memosHealth.summary.readOnly, true);
  assert.strictEqual(memosHealth.summary.discovery.searchToolName, 'search_memory');
  assert.strictEqual(memosHealth.summary.cache.hits, 2);
  assert.strictEqual(calls.find((entry) => entry[0] === 'memos')[1].query, '世界观规则');

  const storageOverlap = await runMemoryOps(parseMemoryOpsArgs(['storage-overlap', '--limit', '3']), { runners });
  assert.strictEqual(storageOverlap.mode, 'storage-overlap');
  assert.strictEqual(storageOverlap.ok, true);
  assert.strictEqual(storageOverlap.summary.expectedIndexCopies.count, 2);
  assert.strictEqual(storageOverlap.summary.vectorOnlyRows.count, 1);
  assert.strictEqual(storageOverlap.summary.recommendedAction, 'run_full_lancedb_reconcile');
  assert.strictEqual(calls.find((entry) => entry[0] === 'storage-overlap')[1].limit, 3);

  const recall = await runMemoryOps(parseMemoryOpsArgs(['recall', '--candidate', 'shadow', '--limit', '1']), { runners });
  assert.strictEqual(recall.mode, 'recall');
  assert.strictEqual(recall.summary.evalMode, 'shadow');
  assert.strictEqual(recall.summary.cases, 1);
  assert.strictEqual(recall.summary.lifecycleLeakage, 0);
  assert.strictEqual(recall.summary.categoryMismatches, 0);
  assert.strictEqual(recall.summary.recentRecallMisses, 0);
  assert.ok(recall.summary.gate);
  assert.ok(recall.summary.casesFile.endsWith('artifacts\\memory-recall-eval\\cases.jsonl') || recall.summary.casesFile.endsWith('artifacts/memory-recall-eval/cases.jsonl'));
  const recallLoad = calls.find((entry) => entry[0] === 'loadCases' && entry[1].limit === 1);
  assert.strictEqual(recallLoad[1].options.autoGold, false);

  await runMemoryOps(parseMemoryOpsArgs(['recall', '--auto-gold', '--limit', '3']), { runners });
  const autoGoldLoad = calls.find((entry) => entry[0] === 'loadCases' && entry[1].limit === 3);
  assert.strictEqual(autoGoldLoad[1].options.autoGold, true);

  const gateRunners = {
    ...runners,
    runMode: async (mode, cases, options) => {
      calls.push(['gateRecall', { mode, cases: cases.length, options }]);
      return {
        mode,
        cases: cases.length,
        judgedCases: 12,
        recallAt8: mode === 'local_jsonl' ? 0.8 : 0.81,
        mrrAt8: mode === 'local_jsonl' ? 0.5 : 0.52,
        leakage: 0,
        lifecycleLeakage: 0,
        categoryMismatches: 0,
        recentRecallMisses: 0,
        emptyResultRate: 0.02,
        noVisibleCandidateRate: 0.02,
        details: []
      };
    },
    runDiagnostics: async () => ({
      ok: true,
      coverage: {
        memory: { readyRatio: 1, staleTableRows: 0, readyButNotSynced: 0 },
        worldbook: { readyRatio: 1, staleTableRows: 0, readyButNotSynced: 0 }
      },
      healthGate: { mustMaterializeFirst: false, mustReconcileFirst: false },
      projectionFreshness: { projectionStale: false }
    })
  };
  const lancedbGate = await runMemoryOps(parseMemoryOpsArgs(['lancedb-gate', '--limit', '1', '--min-judged-cases', '1', '--min-recall-at8', '0.7']), { runners: gateRunners });
  assert.strictEqual(lancedbGate.mode, 'lancedb-gate');
  assert.strictEqual(lancedbGate.ok, true);
  assert.strictEqual(lancedbGate.summary.canPromoteRead, true);

  const invalid = await runMemoryOpsFromArgv(['unknown-mode'], { runners });
  assert.strictEqual(invalid.ok, false);
  assert.strictEqual(invalid.exitCode, EXIT_CODES.usage);
  assert.strictEqual(invalid.error.code, 'invalid_mode');

  assert.deepStrictEqual(parseMemoryOpsPayload('/memoryops'), ['diagnose', '--limit', '20']);
  assert.deepStrictEqual(parseMemoryOpsPayload('/memoryops recall --limit 1'), ['recall', '--limit', '1']);
  const command = parseAdminCommand('/memoryops backfill --source memory');
  assert.strictEqual(command.cmd, 'memoryops');
  assert.strictEqual(command.payload, 'backfill --source memory');

  const coordinator = createMessageAdminCoordinator({
    isAdminUser: (userId) => userId === 'admin_1',
    runMemoryOpsFromArgv: async (argv) => ({
      schemaVersion: SCHEMA_VERSION,
      mode: argv[0],
      ok: true,
      exitCode: 0,
      durationMs: 1,
      summary: { received: argv },
      details: {}
    }),
    formatMemoryOpsAdminReply: (report) => JSON.stringify(buildAdminReplyEnvelope(report))
  });
  const denied = await coordinator.handleMemoryOpsAdminCommand({
    rawText: '/memoryops diagnose',
    userId: 'user_1'
  });
  assert.strictEqual(denied.replyText, '这个按钮现在只给管理员按哦。');

  const adminResult = await coordinator.handleMemoryOpsAdminCommand({
    rawText: '/memoryops recall --limit 1',
    userId: 'admin_1'
  });
  assert.strictEqual(adminResult.handled, true);
  const adminJson = JSON.parse(adminResult.replyText);
  assert.strictEqual(adminJson.schemaVersion, SCHEMA_VERSION);
  assert.strictEqual(adminJson.mode, 'recall');
  assert.deepStrictEqual(adminJson.summary.received, ['recall', '--limit', '1']);

  const sent = [];
  const routeFlow = createMessageRouteFlow({
    isAdminUser: (userId) => userId === 'admin_1',
    sendGroupReply: async (payload) => {
      sent.push(payload);
      return true;
    },
    handleMemoryOpsAdminCommand: async () => ({ handled: true, replyText: '{"ok":true}' })
  });
  const dispatched = await routeFlow.dispatchAdminRoute({
    route: {
      topRouteType: 'admin',
      cleanText: '/memoryops diagnose',
      meta: {
        admin: true,
        command: {
          cmd: 'memoryops',
          raw: '/memoryops diagnose',
          payload: 'diagnose',
          args: ['diagnose']
        }
      }
    },
    groupId: 'g1',
    senderId: 'admin_1',
    rawText: '/memoryops diagnose',
    chatType: 'group'
  });
  assert.strictEqual(dispatched.handled, true);
  assert.strictEqual(dispatched.replyText, '{"ok":true}');
  assert.strictEqual(sent[0].replyText, '{"ok":true}');

  console.log('memoryOpsDiagnosticEntry.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

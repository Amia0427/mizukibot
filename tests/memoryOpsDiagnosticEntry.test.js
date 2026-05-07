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
      probe: {
        cases: 2,
        fallbackCounts: { empty_result: 1 },
        leakage: 0,
        sourceCoverage: { lexical: 2 }
      }
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
  loadCases: (limit) => {
    calls.push(['loadCases', { limit }]);
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
      sourceCoverage: { personal: 1 },
      avgPromptTokenEstimate: 12,
      latency: { main: { p50Ms: 3, p95Ms: 5 } },
      details: [{ id: 'case_1', resultIds: ['node_1'] }]
    };
  }
};

module.exports = (async () => {
  const parsed = parseMemoryOpsArgs(['backfill', '--source', 'memory', '--limit', '7', '--retry-failed']);
  assert.strictEqual(parsed.mode, 'backfill');
  assert.strictEqual(parsed.source, 'memory');
  assert.strictEqual(parsed.limit, 7);
  assert.strictEqual(parsed.retryFailed, true);

  const diagnose = await runMemoryOps(parseMemoryOpsArgs(['diagnose', '--limit', '2']), { runners });
  assert.strictEqual(diagnose.schemaVersion, SCHEMA_VERSION);
  assert.strictEqual(diagnose.mode, 'diagnose');
  assert.strictEqual(diagnose.ok, true);
  assert.strictEqual(diagnose.exitCode, EXIT_CODES.ok);
  assert.ok(Object.prototype.hasOwnProperty.call(diagnose.summary, 'coverage'));
  assert.strictEqual(diagnose.summary.fallback.fallbackCounts.empty_result, 1);

  const backfill = await runMemoryOps(parseMemoryOpsArgs(['backfill', '--source', 'journal', '--limit', '4']), { runners });
  assert.strictEqual(backfill.mode, 'backfill');
  assert.strictEqual(backfill.summary.dryRun, true);
  assert.strictEqual(calls.find((entry) => entry[0] === 'backfill')[1].dryRun, true);
  assert.strictEqual(backfill.summary.embedded, 0);

  const recall = await runMemoryOps(parseMemoryOpsArgs(['recall', '--candidate', 'shadow', '--limit', '1']), { runners });
  assert.strictEqual(recall.mode, 'recall');
  assert.strictEqual(recall.summary.evalMode, 'shadow');
  assert.strictEqual(recall.summary.cases, 1);
  assert.ok(recall.summary.casesFile.endsWith('artifacts\\memory-recall-eval\\cases.jsonl') || recall.summary.casesFile.endsWith('artifacts/memory-recall-eval/cases.jsonl'));

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
  assert.strictEqual(denied.replyText, '仅管理员可用。');

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

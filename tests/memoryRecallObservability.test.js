const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

(() => {
  const oldDataDir = process.env.DATA_DIR;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-recall-observability-'));
  process.env.DATA_DIR = tempDir;
  clearProjectCache();

  const {
    flushMemoryRecallObservabilitySync,
    recordMainPromptBlockObservation,
    recordMemosPlannerRecallObservation,
    resolveObservabilityLogFile
  } = require('../utils/memoryRecallObservability');

  const trace = {
    requestId: 'req_observe',
    phaseSeq: 2,
    startedAt: Date.now() - 25,
    userId: 'u1',
    chatType: 'private'
  };

  const rawRecall = {
    query: '关系称呼',
    used: true,
    promptText: '[MemOSRecall]\n1. 完整内容不应进入测试断言。',
    items: [
      { id: 'remote-1', text: '完整内容不应进入测试断言。', title: '关系设定', source: 'memos_kb', score: 0.91 }
    ],
    diagnostics: {
      enabled: true,
      serverName: 'memos-api-mcp',
      recallSource: 'knowledge_base',
      sourceToolName: 'search_memory',
      durationMs: 321,
      knowledgebaseIdsCount: 1,
      rawCandidateCount: 2,
      queryMode: 'compact',
      queryChanged: true,
      rawQueryPreview: '继续刚才的关系称呼',
      routeGate: {
        enabled: true,
        allowed: true,
        reason: 'allowlist_match',
        matched: 'lore',
        queryClass: 'external_kb',
        allowlist: ['lore'],
        routeSignals: ['lore/worldbook']
      },
      quality: {
        enabled: true,
        minScore: 0.5,
        minChars: 6,
        kept: 1,
        removed: 1,
        removedItems: [
          { id: 'low', reason: 'below_min_score', score: 0.2, text: '低分内容不应进入 prompt。' }
        ]
      },
      rerank: {
        enabled: true,
        candidateCount: 2,
        kept: 1,
        queryTermCount: 4,
        topReasons: [
          { id: 'remote-1', score: 0.91, rerankScore: 1.02, reasons: ['title:1', 'structured'] }
        ]
      },
      cache: {
        hit: false,
        key: 'cache-key-1',
        ttlMs: 300000,
        ageMs: 0
      },
      circuit: {
        open: false,
        failures: 0,
        failureThreshold: 3,
        cooldownMs: 60000
      },
      kbPartition: {
        usedAliasPartition: true,
        matchedAliases: ['lore'],
        fallbackIdsCount: 2
      }
    }
  };
  const dedupedRecall = {
    ...rawRecall,
    used: false,
    promptText: '',
    items: [],
    rejectedReason: 'deduped_by_local_memory',
    diagnostics: {
      ...rawRecall.diagnostics,
      dedupe: {
        enabled: true,
        localEvidenceCount: 1,
        kept: 0,
        removed: 1,
        removedItems: [
          { id: 'remote-1', reason: 'normalized_hash', text: '完整内容不应进入测试断言。' }
        ]
      }
    }
  };

  recordMemosPlannerRecallObservation({
    requestTrace: trace,
    routeMeta: { groupId: 'g1', routePolicyKey: 'direct_chat/main' },
    userId: 'u1',
    query: '关系称呼',
    rawRecall,
    dedupedRecall,
    memoryContext: { memoryForPrompt: '完整内容不应进入测试断言。' }
  });
  recordMainPromptBlockObservation({
    requestTrace: trace,
    routeMeta: { groupId: 'g1', routePolicyKey: 'direct_chat/main' },
    userId: 'u1',
    promptSnapshot: {
      stableBlockIds: ['stable_identity'],
      dynamicBlockIds: ['short_term_continuity', 'retrieved_memory_lite'],
      assistantOnlyBlockIds: [],
      assembledBlocks: [
        { id: 'stable_identity' },
        {
          id: 'short_term_continuity',
          meta: {
            continuity: {
              profileName: 'memory_recall',
              rawTurnCount: 12,
              selectedRawTurnCount: 8,
              selectedNewestRawTurnCount: 3,
              selectedImportantRawTurnCount: 2,
              sessionSummaryCount: 1,
              shortTermSummaryChars: 80,
              trimReasons: ['message_limit_importance_selection']
            }
          }
        },
        { id: 'retrieved_memory_lite' }
      ],
      tokenUsageByBlock: [
        { id: 'short_term_continuity', tokens: 88 },
        { id: 'retrieved_memory_lite', tokens: 12 }
      ],
      trimDecisions: []
    },
    memoryContext: { memoryForPrompt: '完整内容不应进入测试断言。' },
    memosRecall: dedupedRecall,
    dynamicPromptPlan: {
      source: 'planner',
      enabledBlockIds: ['retrieved_memory_lite'],
      blockDecisions: [
        { blockId: 'memos_recall', decision: 'skip', confidence: 0.9, reason: 'duplicate local memory' }
      ]
    }
  });
  recordMainPromptBlockObservation({
    requestTrace: trace,
    routeMeta: { groupId: 'g1', routePolicyKey: 'direct_chat/main' },
    userId: 'u1',
    promptSnapshot: {
      stableBlockIds: ['stable_identity'],
      dynamicBlockIds: ['short_term_continuity'],
      assistantOnlyBlockIds: [],
      assembledBlocks: [
        { id: 'stable_identity' },
        { id: 'short_term_continuity' }
      ],
      tokenUsageByBlock: [],
      trimDecisions: []
    },
    memoryContext: {},
    memosRecall: {},
    dynamicPromptPlan: {
      source: 'planner',
      enabledBlockIds: ['memos_recall'],
      blockDecisions: [
        { blockId: 'memos_recall', decision: 'include', confidence: 0.8, reason: 'available remotely' }
      ]
    }
  });
  flushMemoryRecallObservabilitySync();

  const lines = fs.readFileSync(resolveObservabilityLogFile(), 'utf8').trim().split(/\r?\n/);
  assert.strictEqual(lines.length, 3);
  const planner = JSON.parse(lines[0]);
  const prompt = JSON.parse(lines[1]);
  const dropped = JSON.parse(lines[2]);
  assert.strictEqual(planner.requestId, 'req_observe');
  assert.strictEqual(planner.memos.usedBeforeDedupe, true);
  assert.strictEqual(planner.memos.usedAfterDedupe, false);
  assert.strictEqual(planner.memos.dedupe.removed, 1);
  assert.strictEqual(planner.memos.queryMode, 'compact');
  assert.strictEqual(planner.memos.queryChanged, true);
  assert.strictEqual(planner.memos.routeGate.reason, 'allowlist_match');
  assert.strictEqual(planner.memos.quality.removed, 1);
  assert.strictEqual(planner.memos.rerank.enabled, true);
  assert.strictEqual(planner.memos.rerank.kept, 1);
  assert.strictEqual(planner.memos.cache.hit, false);
  assert.strictEqual(planner.memos.circuit.open, false);
  assert.strictEqual(planner.memos.kbPartition.usedAliasPartition, true);
  assert.ok(planner.memos.rawItems[0].textHash);
  assert.ok(planner.memos.rawItems[0].textPreview.includes('完整内容'));
  assert.strictEqual(prompt.prompt.hasMemosRecall, false);
  assert.strictEqual(prompt.prompt.hasRetrievedMemoryLite, true);
  assert.strictEqual(prompt.prompt.shortTermContinuity.injectedTokens, 88);
  assert.strictEqual(prompt.prompt.shortTermContinuity.contextProfile, 'memory_recall');
  assert.strictEqual(prompt.prompt.shortTermContinuity.selectedImportantRawTurnCount, 2);
  assert.ok(prompt.prompt.shortTermContinuity.trimReasons.includes('message_limit_importance_selection'));
  assert.strictEqual(prompt.planner.memosRecallDecision.decision, 'skip');
  assert.strictEqual(prompt.drop.dropped, false);
  assert.strictEqual(dropped.stage, 'memos_recall_dropped_before_prompt');
  assert.strictEqual(dropped.planner.includedMemosRecall, true);
  assert.deepStrictEqual(dropped.drop.reasons, ['planner_included_but_memos_recall_unused']);

  clearProjectCache();
  if (oldDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = oldDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('memoryRecallObservability.test.js passed');
})();

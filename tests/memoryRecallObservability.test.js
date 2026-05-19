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
      knowledgebaseIdsCount: 1
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
        { id: 'short_term_continuity' },
        { id: 'retrieved_memory_lite' }
      ],
      tokenUsageByBlock: [
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
  flushMemoryRecallObservabilitySync();

  const lines = fs.readFileSync(resolveObservabilityLogFile(), 'utf8').trim().split(/\r?\n/);
  assert.strictEqual(lines.length, 2);
  const planner = JSON.parse(lines[0]);
  const prompt = JSON.parse(lines[1]);
  assert.strictEqual(planner.requestId, 'req_observe');
  assert.strictEqual(planner.memos.usedBeforeDedupe, true);
  assert.strictEqual(planner.memos.usedAfterDedupe, false);
  assert.strictEqual(planner.memos.dedupe.removed, 1);
  assert.ok(planner.memos.rawItems[0].textHash);
  assert.ok(planner.memos.rawItems[0].textPreview.includes('完整内容'));
  assert.strictEqual(prompt.prompt.hasMemosRecall, false);
  assert.strictEqual(prompt.prompt.hasRetrievedMemoryLite, true);
  assert.strictEqual(prompt.planner.memosRecallDecision.decision, 'skip');

  clearProjectCache();
  if (oldDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = oldDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('memoryRecallObservability.test.js passed');
})();

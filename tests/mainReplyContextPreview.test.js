const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-main-reply-context-preview-'));
const logFile = path.join(tempDir, 'memory-recall-observability.ndjson');

fs.writeFileSync(logFile, [
  JSON.stringify({
    recordedAt: '2026-05-21T14:00:00.000Z',
    stage: 'prepare_main_prompt_blocks',
    userId: 'u_preview',
    routePolicyKey: 'chat/default',
    topRouteType: 'direct_chat',
    prompt: {
      dynamicBlockIds: ['short_term_continuity', 'retrieved_memory_lite', 'daily_journal'],
      hasShortTermContinuity: true,
      hasRetrievedMemoryLite: true,
      hasMemosRecall: false,
      shortTermContinuity: {
        contextProfile: 'memory_recall',
        rawTurnCount: 30,
        selectedRawTurnCount: 18,
        sessionSummaryCount: 2,
        trimReasons: ['message_limit_importance_selection']
      }
    },
    localMemory: { evidenceCount: 2 },
    memoryTrace: {
      retrieval_path: 'v3',
      retrieved_count: 1,
      dropped_reasons: ['lancedb_read_disabled'],
      injected_block_ids: ['retrieved_memory_lite'],
      hits: [{
        id: 'node_preview',
        source: 'personal',
        sourceKind: 'explicit',
        category: 'preference',
        tags: ['drink'],
        intent: 'personalization',
        status: 'active',
        lifecycleStatus: 'active',
        scopeType: 'personal',
        score: 0.91,
        matchMode: 'hybrid',
        selectionReason: 'category_match',
        injected: true,
        preview: '喜欢柚子茶'
      }]
    },
    memos: { used: false }
  })
].join('\n') + '\n');

const { buildMainReplyContextPreview } = require('../utils/mainReplyContextPreview');

const preview = buildMainReplyContextPreview({
  limit: 5,
  observabilityFile: logFile,
  listModelCalls: () => [{
    started_at: '2026-05-21T14:01:00.000Z',
    source: 'direct_reply',
    status: 'succeeded',
    route_policy_key: 'chat/default',
    top_route_type: 'direct_chat',
    prompt_integrity: { has_system_prompt: true }
  }]
});

assert.strictEqual(preview.schemaVersion, 'main_reply_context_preview_v1');
assert.strictEqual(preview.observations.length, 1);
assert.strictEqual(preview.observations[0].hasDailyJournal, true);
assert.strictEqual(preview.observations[0].shortTermContinuity.contextProfile, 'memory_recall');
assert.strictEqual(preview.observations[0].memoryTrace.retrievalPath, 'v3');
assert.strictEqual(preview.observations[0].memoryTrace.hits[0].category, 'preference');
assert.deepStrictEqual(preview.observations[0].memoryTrace.droppedReasons, ['lancedb_read_disabled']);
assert.strictEqual(preview.modelCalls[0].promptIntegrity.has_system_prompt, true);

console.log('mainReplyContextPreview.test.js passed');

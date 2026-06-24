const assert = require('assert');

const {
  buildMemoryV3RagExplainDiagnostic
} = require('../utils/memory-v3/ragExplainDiagnostic');

const journalWinner = {
  id: 'journal-segment:u1:2026-04-26:0',
  source: 'journal',
  type: 'daily_journal_segment',
  scopeType: 'personal',
  text: '讨论清真寿司点单、味淋替代方案和酱汁避雷。',
  score: 0.92,
  lexical: 0.24,
  embedding: 0.99,
  rerankScore: 0.95,
  matchMode: 'hybrid_rerank',
  selectionReason: 'facet_journal_selected',
  day: '2026-04-26'
};

const profileLoser = {
  id: 'profile:u1:like:0',
  source: 'profile',
  type: 'like',
  scopeType: 'personal',
  text: '清真寿司和味淋替代方案',
  score: 0.77,
  lexical: 0.12,
  embedding: 0.98,
  rerankScore: 0.74,
  matchMode: 'stable_profile',
  selectionReason: 'stable_profile_trace'
};

module.exports = buildMemoryV3RagExplainDiagnostic({
  userId: 'u1',
  query: '昨天聊的清真寿司点单是什么',
  facet: 'journal',
  topK: 5
}, {
  stageLimit: 5,
  deps: {
    resolveReadableGroupIds: () => [],
    collectCandidates: () => [journalWinner, profileLoser],
    filterCandidatesBySource: (items) => items,
    queryMemory: async () => ({
      ok: true,
      userId: 'u1',
      query: '昨天聊的清真寿司点单是什么',
      facet: 'journal',
      results: [journalWinner],
      strictResults: [journalWinner],
      weakResults: [],
      sourceCoverage: { journal: 1 },
      diagnostics: {
        retrievalPlan: { facet: 'journal' },
        sourcePlan: { primary: ['journal', 'profile'] },
        journalIntent: { isJournalIntent: true },
        recentRecallIntent: { matched: true },
        timings: { totalMs: 3 },
        projectionFreshness: { projectionStale: false },
        recall: {
          rankFusion: {
            fused: [journalWinner, profileLoser],
            rerank: [journalWinner, profileLoser],
            local: [journalWinner, profileLoser]
          },
          rerank: {
            enabled: true,
            applied: true,
            candidates: 2,
            limit: 2,
            tail: 0,
            beforeTop: [
              { rank: 1, id: journalWinner.id, score: 0.92, rerankScore: 0, matchMode: 'hybrid' },
              { rank: 2, id: profileLoser.id, score: 0.77, rerankScore: 0, matchMode: 'stable_profile' }
            ],
            afterTop: [
              { rank: 1, id: journalWinner.id, score: 0.95, rerankScore: 0.95, matchMode: 'hybrid_rerank' },
              { rank: 2, id: profileLoser.id, score: 0.74, rerankScore: 0.74, matchMode: 'stable_profile' }
            ],
            afterRuntime: { disabled: false }
          },
          semanticDedup: {
            enabled: true,
            threshold: 0.9,
            compared: 1,
            collapsed: 1,
            pairs: [
              {
                winnerId: journalWinner.id,
                loserId: profileLoser.id,
                winnerSource: 'journal',
                loserSource: 'profile',
                similarity: 0.97,
                reason: 'semantic_duplicate_collapsed'
              }
            ]
          }
        }
      }
    }),
    buildMemoryContextAsync: async () => ({
      diagnostics: {
        memoryTrace: {
          injected_block_ids: ['retrieved_memory_lite', 'long_term_profile'],
          injected: [
            { name: 'retrievedMemory', chars: 80, approxTokens: 20, preview: '讨论清真寿司点单、味淋替代方案和酱汁避雷。' },
            { name: 'longTermProfile', chars: 16, approxTokens: 4, preview: '清真寿司和味淋替代方案' }
          ],
          dropped_reasons: [],
          profile_trace_items: [
            { field: 'likes', text: '清真寿司和味淋替代方案', confidence: 0.9 }
          ]
        }
      },
      stats: {
        localKnowledge: {}
      }
    })
  }
}).then((report) => {
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.stages.journalSegmentHits.count, 1);
  assert.ok(report.stages.longTermProfileHits.count >= 1);
  assert.strictEqual(report.stages.rerank.applied, true);
  assert.strictEqual(report.stages.journalVsLongTermDedup.collapsed, 1);
  assert.ok(report.stages.journalVsLongTermDedup.pairs.some((pair) => pair.loserSource === 'profile'));
  assert.strictEqual(report.stages.finalResults.resultCount, 1);
  assert.strictEqual(report.stages.finalResults.retained[0].id, journalWinner.id);
  console.log('memoryV3RagExplainDedupStage.test.js passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

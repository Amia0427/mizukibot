const assert = require('assert');

const {
  buildChatDefaultMemoryLeakDiagnostic,
  collectBlockEvidenceFromModelCall,
  collectBlockEvidenceFromObservation,
  formatChatDefaultMemoryLeakDiagnostic,
  isOrdinaryMainReplyModelCall,
  parseArgs,
  parseDurationMs,
  rowHasExplicitRecallSignal
} = require('../utils/chatDefaultMemoryLeakDiagnostics');

function modelCall(requestId, extra = {}) {
  return {
    ts: '2026-06-13T07:00:00.000Z',
    id: `model_${requestId}`,
    status: 'succeeded',
    source: 'v2_streaming_reply',
    request_id: requestId,
    model: 'claude-opus-4-6-thinking',
    provider: 'openai_compatible',
    host: 'example.test',
    route_policy_key: 'chat/default',
    route_debug_key: 'direct_chat/text_chat/answer',
    top_route_type: 'direct_chat',
    dispatch_branch: 'direct_reply',
    trigger_branch: 'direct_reply.streaming_guarded_upstream',
    memory_injected: true,
    prompt_integrity: {
      memory_marker_count: 2,
      memory_markers: {
        retrieved_memory: 1,
        daily_journal: 1,
        short_term_continuity: 1
      },
      has_retrieved_memory: true,
      has_daily_journal: true,
      token_budget: {
        estimated_input_tokens: 8000
      }
    },
    ...extra
  };
}

function trace(requestId, phaseSeq, tracePhase, extra = {}) {
  return {
    recordedAt: new Date(Date.parse('2026-06-13T07:00:00.000Z') + phaseSeq * 1000).toISOString(),
    requestId,
    phaseSeq,
    tracePhase,
    stage: tracePhase,
    routePolicyKey: 'chat/default',
    topRouteType: 'direct_chat',
    chatType: 'group',
    groupId: '1092700300',
    userId: '1960901788',
    messageId: 'm1',
    ...extra
  };
}

function observation(requestId, extra = {}) {
  return {
    recordedAt: '2026-06-13T07:00:08.000Z',
    requestId,
    stage: 'prepare_main_prompt_blocks',
    routePolicyKey: 'chat/default',
    topRouteType: 'direct_chat',
    prompt: {
      dynamicBlockIds: ['short_term_continuity', 'memory_recall_policy', 'daily_journal'],
      hasRetrievedMemoryLite: true
    },
    planner: {
      enabledBlockIds: ['memory_recall_policy'],
      dynamicPromptPlanSource: 'heuristic'
    },
    memoryTrace: {
      retrieval_path: 'ambient',
      retrieved_count: 2,
      injected_block_ids: ['retrieved_memory_lite', 'memory_recall_policy']
    },
    ...extra
  };
}

module.exports = (() => {
  const leakCall = modelCall('req_leak');
  const cleanCall = modelCall('req_clean', {
    request_id: 'req_clean',
    id: 'model_req_clean',
    memory_injected: false,
    prompt_integrity: {
      memory_marker_count: 1,
      memory_markers: { short_term_continuity: 1 },
      has_retrieved_memory: false,
      has_daily_journal: false
    }
  });
  const explicitRecallCall = modelCall('req_recall');
  const nonMainCall = modelCall('req_memory_extract', {
    source: 'memory_extraction',
    request_id: '',
    route_policy_key: 'chat/default'
  });

  assert.strictEqual(isOrdinaryMainReplyModelCall(leakCall), true);
  assert.strictEqual(isOrdinaryMainReplyModelCall(nonMainCall), false);
  assert.strictEqual(rowHasExplicitRecallSignal({ routePolicyKey: 'lookup/notebook-answer' }), true);
  assert.strictEqual(rowHasExplicitRecallSignal({ needsMemory: true }), true);
  assert.strictEqual(rowHasExplicitRecallSignal({ routePolicyKey: 'chat/default' }), false);

  const modelEvidence = collectBlockEvidenceFromModelCall(leakCall);
  assert.deepStrictEqual(modelEvidence.blocks.sort(), ['daily_journal', 'retrieved_memory_lite']);
  const observationEvidence = collectBlockEvidenceFromObservation(observation('req_leak'));
  assert.ok(observationEvidence.blocks.includes('memory_recall_policy'));

  const report = buildChatDefaultMemoryLeakDiagnostic({
    modelRows: [
      leakCall,
      cleanCall,
      explicitRecallCall,
      nonMainCall
    ],
    traceRows: [
      trace('req_leak', 1, 'message_ingress'),
      trace('req_leak', 2, 'dispatch_branch_selected', { dispatchBranch: 'direct_reply' }),
      trace('req_clean', 1, 'message_ingress'),
      trace('req_recall', 1, 'message_ingress', { needsMemory: true, needsMemoryReason: 'explicit_recall' }),
      trace('req_recall', 2, 'dispatch_branch_selected', { routePolicyKey: 'lookup/notebook-answer' })
    ],
    observationRows: [
      observation('req_leak'),
      observation('req_recall', {
        planner: {
          enabledBlockIds: ['retrieved_memory_lite', 'memory_recall_policy'],
          dynamicPromptPlanSource: 'memory_recall'
        },
        memoryTrace: {
          retrieval_path: 'explicit_recall',
          injected_block_ids: ['retrieved_memory_lite', 'memory_recall_policy']
        }
      })
    ],
    limit: 5,
    nowMs: Date.parse('2026-06-13T07:10:00.000Z')
  });

  assert.strictEqual(report.schemaVersion, 'chat_default_memory_leak_diagnostic_v1');
  assert.strictEqual(report.summary.candidateChatDefaultRequests, 3);
  assert.strictEqual(report.summary.violationRequests, 1);
  assert.strictEqual(report.summary.clean, false);
  assert.strictEqual(report.violations[0].requestId, 'req_leak');
  assert.deepStrictEqual(report.violations[0].blockIds.sort(), ['daily_journal', 'memory_recall_policy', 'retrieved_memory_lite']);
  assert.ok(report.violations[0].evidence.some((item) => item.blockId === 'memory_recall_policy'));
  assert.ok(formatChatDefaultMemoryLeakDiagnostic(report).includes('req_leak'));

  const cleanReport = buildChatDefaultMemoryLeakDiagnostic({
    modelRows: [cleanCall],
    traceRows: [trace('req_clean', 1, 'message_ingress')],
    observationRows: [],
    nowMs: Date.parse('2026-06-13T07:10:00.000Z')
  });
  assert.strictEqual(cleanReport.summary.clean, true);
  assert.ok(formatChatDefaultMemoryLeakDiagnostic(cleanReport).includes('No chat/default memory block violations'));

  const parsed = parseArgs(['--window=2h', '--limit=7', '--json', '--exclude-admin']);
  assert.strictEqual(parsed.sinceMs, 2 * 60 * 60 * 1000);
  assert.strictEqual(parsed.limit, 7);
  assert.strictEqual(parsed.json, true);
  assert.strictEqual(parsed.includeAdmin, false);
  assert.strictEqual(parseDurationMs('2d'), 2 * 24 * 60 * 60 * 1000);

  console.log('chatDefaultMemoryLeakDiagnostics.test.js passed');
})();

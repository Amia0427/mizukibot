const assert = require('assert');

process.env.MEMOS_MCP_ENABLED = 'false';
process.env.MEMOS_REMOTE_RECALL_ENABLED = 'false';
process.env.OPENVIKING_ENABLED = 'false';
process.env.OPENVIKING_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_RERANK_ENABLED = 'false';
process.env.PERSONA_WORLDBOOK_EMBEDDING_ENABLED = 'false';
process.env.PERSONA_WORLDBOOK_SEMANTIC_LIMIT = '0';
process.env.PERSONA_WORLDBOOK_RERANK_ENABLED = 'false';
process.env.LOCAL_PROMPT_RECALL_ENABLED = 'false';
process.env.PROMPT_OPTIONAL_BUILD_ENABLED = 'true';
process.env.PROMPT_OPTIONAL_BUILD_BUDGET_MS = '10000';

const {
  buildMainReplyPromptAssemblyDiagnostic
} = require('../utils/mainReplyPromptAssemblyDiagnostics');
const {
  ensureWorldbookSqlImported,
  loadPersonaModuleCatalog
} = require('../utils/personaModules');
const {
  clearWorldbookSessionState,
  getWorldbookSessionState
} = require('../utils/personaWorldbookSearch/sessionState');

function modelCall(requestId) {
  return {
    ts: '2026-06-13T12:00:00.000Z',
    id: `model_${requestId}`,
    status: 'succeeded',
    source: 'v2_streaming_reply',
    request_id: requestId,
    provider: 'openai_compatible',
    model: 'diag-model',
    route_policy_key: 'chat/default',
    top_route_type: 'direct_chat',
    dispatch_branch: 'direct_reply',
    prompt_integrity: {
      system_message_count: 8,
      has_system_prompt: true,
      memory_marker_count: 2,
      memory_markers: {
        retrieved_memory: 1,
        daily_journal: 1
      },
      has_retrieved_memory: true,
      has_daily_journal: true,
      token_budget: {
        estimated_input_tokens: 4096
      }
    }
  };
}

function observation(requestId) {
  return {
    recordedAt: '2026-06-13T12:00:01.000Z',
    requestId,
    stage: 'prepare_main_prompt_blocks',
    routePolicyKey: 'chat/default',
    topRouteType: 'direct_chat',
    prompt: {
      stableBlockIds: ['root_system_prompt', 'security_contract', 'main_persona_system'],
      dynamicBlockIds: ['roleplay_runtime_context', 'persona_module_wb_mizuki_future_two_tracks'],
      assistantOnlyBlockIds: ['dynamic_few_shot'],
      assembledBlockCount: 6,
      tokenUsageByBlock: [
        { id: 'root_system_prompt', tokens: 12 },
        { id: 'persona_module_wb_mizuki_future_two_tracks', tokens: 80 }
      ]
    },
    planner: {
      dynamicPromptPlanSource: 'heuristic',
      enabledBlockIds: ['roleplay_runtime_context']
    }
  };
}

(async () => {
  ensureWorldbookSqlImported(loadPersonaModuleCatalog(), { force: true });
  clearWorldbookSessionState('diag-prompt-assembly-test');

  const rebuilt = await buildMainReplyPromptAssemblyDiagnostic({
    requestText: '服饰专门学校和N25两个都不放弃',
    userId: 'u_prompt_diag',
    chatType: 'private',
    sessionKey: 'diag-prompt-assembly-test',
    routePolicyKey: 'chat/default',
    topRouteType: 'direct_chat',
    worldbookSemanticLimit: 0,
    worldbookEmbeddingHotPath: false
  });

  assert.strictEqual(rebuilt.schemaVersion, 'main_reply_prompt_assembly_diagnostic_v1');
  assert.strictEqual(rebuilt.mode, 'test_input');
  assert.strictEqual(rebuilt.exactPromptRebuilt, true);
  assert.ok(rebuilt.promptAssembly.stableBlocks.some((item) => item.id === 'main_persona_system'));
  assert.ok(rebuilt.promptAssembly.dynamicBlocks.some((item) => item.moduleId === 'wb_mizuki_future_two_tracks'));
  assert.ok(rebuilt.personaModules.selected.includes('wb_mizuki_future_two_tracks'));
  assert.ok(rebuilt.personaWorldbook.selected.some((item) => item.id === 'wb_mizuki_future_two_tracks'));
  assert.strictEqual(rebuilt.personaWorldbook.sqlPrimaryRead, true);
  assert.ok(rebuilt.personaWorldbook.selected.every((item) => item.sourcePolicy === 'persona_worldbook_sql_primary_read'));
  assert.strictEqual(rebuilt.personaWorldbook.search.sessionState?.readOnly, true);
  assert.deepStrictEqual(getWorldbookSessionState('diag-prompt-assembly-test'), []);
  assert.strictEqual(rebuilt.planner.provided, false);
  assert.strictEqual(rebuilt.planner.source, 'heuristic');
  assert.ok(
    rebuilt.runtimeLocalInjection.selectedWithoutPlanner.some((item) => item.moduleId === 'wb_mizuki_future_two_tracks'),
    'worldbook module must still be selected locally when planner is not provided'
  );

  const requestIdReport = await buildMainReplyPromptAssemblyDiagnostic({
    requestId: 'req_prompt_diag',
    modelRows: [modelCall('req_prompt_diag')],
    traceRows: [
      {
        requestId: 'req_prompt_diag',
        recordedAt: '2026-06-13T12:00:00.500Z',
        phaseSeq: 1,
        tracePhase: 'planner_timeout',
        stage: 'planner_timeout',
        routePolicyKey: 'chat/default',
        topRouteType: 'direct_chat'
      }
    ],
    observationRows: [observation('req_prompt_diag')]
  });

  assert.strictEqual(requestIdReport.mode, 'request_id');
  assert.strictEqual(requestIdReport.exactPromptRebuilt, false);
  assert.strictEqual(requestIdReport.summary.foundModelCall, true);
  assert.strictEqual(requestIdReport.summary.foundPromptObservation, true);
  assert.strictEqual(requestIdReport.planner.source, 'heuristic');
  assert.ok(requestIdReport.planner.traceSignals.includes('planner_timeout'));
  assert.ok(requestIdReport.observed.blockIds.dynamic.includes('persona_module_wb_mizuki_future_two_tracks'));
  assert.ok(requestIdReport.promptAssembly.dynamicBlocks.some((item) => item.moduleId === 'wb_mizuki_future_two_tracks'));
  assert.ok(requestIdReport.personaModules.selected.includes('wb_mizuki_future_two_tracks'));
  assert.ok(requestIdReport.personaWorldbook.selected.some((item) => item.id === 'wb_mizuki_future_two_tracks'));
  assert.ok(requestIdReport.runtimeLocalInjection.selectedWithoutPlanner.some((item) => item.moduleId === 'wb_mizuki_future_two_tracks'));
  assert.ok(
    requestIdReport.observed.blockSourceIndex.dynamicBlocks.some((item) => (
      item.moduleId === 'wb_mizuki_future_two_tracks'
      && item.sourcePolicy === 'persona_worldbook_sql_primary_read'
      && item.sourceConfidence === 'current_code_inference'
    ))
  );
  assert.ok(requestIdReport.observed.modelCall.promptIntegrity.inferredBlockIds.includes('retrieved_memory_lite'));

  clearWorldbookSessionState('diag-prompt-assembly-test');
  console.log('mainReplyPromptAssemblyDiagnostics.test.js passed');
  process.exit(0);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

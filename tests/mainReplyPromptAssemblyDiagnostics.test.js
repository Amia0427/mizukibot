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
      dynamicBlockIds: ['roleplay_runtime_context', 'live_state_dynamic', 'persona_module_wb_mizuki_future_two_tracks'],
      assistantOnlyBlockIds: ['dynamic_few_shot'],
      assembledBlockCount: 6,
      tokenUsageByBlock: [
        { id: 'root_system_prompt', tokens: 12 },
        { id: 'live_state_dynamic', tokens: 66 },
        { id: 'persona_module_wb_mizuki_future_two_tracks', tokens: 80 }
      ],
      liveStateDynamic: {
        hit: true,
        block: {
          id: 'live_state_dynamic',
          label: 'Live State Dynamic',
          lane: 'dynamic_context',
          priority: 500,
          source: 'live_state',
          budgetTokens: 800
        },
        sourceDiagnostics: {
          relationshipBoundary: {
            sourceFile: 'utils/liveState/relationshipBoundary.js',
            sourcePolicy: 'getRelationshipBoundary',
            dataSource: 'memory_v3_relationship_projection',
            found: true,
            readOnly: true
          },
          currentActivity: {
            sourceFile: 'utils/liveState/currentActivity.js',
            sourcePolicy: 'getCurrentActivity',
            dataSource: 'timezone_clock_bucket',
            found: true,
            readOnly: true
          },
          recentContext: {
            sourceFile: 'utils/liveState/recentContext.js',
            sourcePolicy: 'getRecentContextSummary',
            dataSource: 'daily_journal_recent_entries',
            found: true,
            readOnly: true,
            entriesRead: 1,
            summariesUsed: 1
          },
          antiAIRules: {
            sourceFile: 'utils/liveState/antiAIRules.js',
            sourcePolicy: 'getAntiAIRules',
            dataSource: 'deterministic_route_and_turn_heuristics',
            found: true,
            readOnly: true
          }
        },
        lengths: {
          beforeTrimChars: 360,
          afterTrimChars: 300,
          beforeTrimTokens: 120,
          afterTrimTokens: 66,
          tokenLimit: 800,
          truncated: true
        },
        finalTokenEstimate: 66,
        promptPosition: {
          index: 4,
          position: 5,
          totalBlocks: 6,
          lane: 'dynamic_context',
          laneIndex: 1,
          lanePosition: 2,
          laneTotal: 3,
          previousBlockId: 'roleplay_inner_protocol',
          nextBlockId: 'persona_module_wb_mizuki_future_two_tracks',
          orderSource: 'promptSnapshot.assembledBlocks'
        }
      },
      stageTimings: {
        schemaVersion: 'prompt_assembly_stage_timing_v1',
        readOnly: true,
        totalDurationMs: 123,
        promptCollectMs: 45,
        promptRenderMs: 78,
        stages: [
          { name: 'collectPromptInputs', category: 'collect', durationMs: 45, status: 'ok', readOnly: true, source: '' },
          { name: 'persona_worldbook', category: 'collect', durationMs: 12, status: 'ok', readOnly: true, source: 'utils/personaModules.buildPersonaModuleCandidatesAsync' },
          { name: 'profile_journal_db', category: 'memory_context', durationMs: 8, status: 'observed', readOnly: true, source: 'utils/profileJournalDb' },
          { name: 'daily_journal', category: 'memory_context', durationMs: 8, status: 'ok', readOnly: true, source: 'utils/dailyJournal.getDailyJournalRetrievalBundle' },
          { name: 'short_term_continuity', category: 'collect', durationMs: 3, status: 'ok', readOnly: true, source: 'utils/shortTermMemory.buildSharedShortTermContextMessages' },
          { name: 'renderPromptLayers.session', category: 'render', durationMs: 22, status: 'ok', readOnly: true, source: 'renderPromptLayers' }
        ],
        byName: {
          collectPromptInputs: { count: 1, durationMs: 45, maxDurationMs: 45, status: 'ok', category: 'collect', source: '' },
          persona_worldbook: { count: 1, durationMs: 12, maxDurationMs: 12, status: 'ok', category: 'collect', source: 'utils/personaModules.buildPersonaModuleCandidatesAsync' },
          profile_journal_db: { count: 1, durationMs: 8, maxDurationMs: 8, status: 'observed', category: 'memory_context', source: 'utils/profileJournalDb' },
          daily_journal: { count: 1, durationMs: 8, maxDurationMs: 8, status: 'ok', category: 'memory_context', source: 'utils/dailyJournal.getDailyJournalRetrievalBundle' },
          short_term_continuity: { count: 1, durationMs: 3, maxDurationMs: 3, status: 'ok', category: 'collect', source: 'utils/shortTermMemory.buildSharedShortTermContextMessages' },
          'renderPromptLayers.session': { count: 1, durationMs: 22, maxDurationMs: 22, status: 'ok', category: 'render', source: 'renderPromptLayers' }
        },
        hotspots: [
          { name: 'collectPromptInputs', durationMs: 45, category: 'collect', source: '', status: 'ok' }
        ]
      }
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
    now: '2026-06-14T02:00:00+08:00',
    timezone: 'Asia/Shanghai',
    memoryV3: {
      async queryProjection() {
        return [{ relationType: 'friend', closeness: 55, intimacy: 30, tags: ['diag_friend'] }];
      }
    },
    dailyJournal: {
      async queryRecent() {
        return [{ summary: '最近聊过服饰专门学校和N25的两条路' }];
      }
    },
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
  assert.strictEqual(rebuilt.liveStateDynamic.hit, true);
  assert.strictEqual(rebuilt.liveStateDynamic.sources.relationshipBoundary.dataSource, 'memory_v3_relationship_projection');
  assert.strictEqual(rebuilt.liveStateDynamic.sources.currentActivity.dataSource, 'timezone_clock_bucket');
  assert.strictEqual(rebuilt.liveStateDynamic.sources.recentContext.dataSource, 'daily_journal_recent_entries');
  assert.strictEqual(rebuilt.liveStateDynamic.sources.antiAIRules.dataSource, 'deterministic_route_and_turn_heuristics');
  assert.ok(rebuilt.liveStateDynamic.lengths.beforeTrimTokens >= rebuilt.liveStateDynamic.lengths.afterTrimTokens);
  assert.ok(rebuilt.liveStateDynamic.finalTokenEstimate > 0);
  assert.ok(rebuilt.liveStateDynamic.promptPosition.position > 0);
  assert.strictEqual(rebuilt.liveStateDynamic.promptBlock.priority, 500);
  assert.ok(rebuilt.liveStateDynamic.selection.runtimeAdded);
  assert.strictEqual(rebuilt.promptAssemblyStageTimings.schemaVersion, 'prompt_assembly_stage_timing_v1');
  assert.strictEqual(rebuilt.promptAssemblyStageTimings.readOnly, true);
  assert.ok(Number(rebuilt.promptAssemblyStageTimings.promptCollectMs) >= 0);
  assert.ok(Number(rebuilt.promptAssemblyStageTimings.promptRenderMs) >= 0);
  for (const name of [
    'buildDynamicPromptImpl',
    'collectPromptInputs',
    'memory_context',
    'persona_worldbook',
    'profile_journal_db',
    'short_term_continuity',
    'daily_journal',
    'renderPromptLayers.stable',
    'renderPromptLayers.session',
    'renderPromptLayers.optional'
  ]) {
    assert.ok(
      rebuilt.promptAssemblyStageTimings.stages.some((item) => item.name === name),
      `rebuilt timing must include ${name}`
    );
  }
  assert.ok(
    rebuilt.promptAssemblyStageTimings.stages.every((item) => item.readOnly === true),
    'prompt assembly timings must stay read-only diagnostics'
  );
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
      },
      {
        requestId: 'req_prompt_diag',
        recordedAt: '2026-06-13T12:00:00.700Z',
        phaseSeq: 2,
        tracePhase: 'runtime_v2_live_state_prepared',
        stage: 'live_state_prepared',
        routePolicyKey: 'chat/default',
        topRouteType: 'direct_chat',
        relationship: 'friend',
        tokens: 66,
        durationMs: 4,
        hasContext: true
      }
    ],
    observationRows: [observation('req_prompt_diag')]
  });

  assert.strictEqual(requestIdReport.mode, 'request_id');
  assert.strictEqual(requestIdReport.exactPromptRebuilt, false);
  assert.strictEqual(requestIdReport.summary.foundModelCall, true);
  assert.strictEqual(requestIdReport.summary.foundPromptObservation, true);
  assert.strictEqual(requestIdReport.summary.liveStateDynamicHit, true);
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
  assert.strictEqual(requestIdReport.liveStateDynamic.hit, true);
  assert.strictEqual(requestIdReport.liveStateDynamic.sources.relationshipBoundary.dataSource, 'memory_v3_relationship_projection');
  assert.strictEqual(requestIdReport.liveStateDynamic.lengths.beforeTrimTokens, 120);
  assert.strictEqual(requestIdReport.liveStateDynamic.lengths.afterTrimTokens, 66);
  assert.strictEqual(requestIdReport.liveStateDynamic.finalTokenEstimate, 66);
  assert.strictEqual(requestIdReport.liveStateDynamic.promptPosition.position, 5);
  assert.strictEqual(requestIdReport.liveStateDynamic.traceEvent.stage, 'live_state_prepared');
  assert.strictEqual(requestIdReport.observed.promptObservation.prompt.stageTimings.schemaVersion, 'prompt_assembly_stage_timing_v1');
  assert.strictEqual(requestIdReport.promptAssemblyStageTimings.readOnly, true);
  for (const name of ['collectPromptInputs', 'persona_worldbook', 'profile_journal_db', 'daily_journal', 'short_term_continuity', 'renderPromptLayers.session']) {
    assert.ok(
      requestIdReport.promptAssemblyStageTimings.stages.some((item) => item.name === name),
      `request-id timing must include ${name}`
    );
  }

  clearWorldbookSessionState('diag-prompt-assembly-test');
  console.log('mainReplyPromptAssemblyDiagnostics.test.js passed');
  process.exit(0);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

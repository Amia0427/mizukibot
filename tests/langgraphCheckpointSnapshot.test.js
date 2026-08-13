const assert = require('assert');

const { snapshotState } = require('../api/runtimeV2/state');

(() => {
  const state = {
    request: { question: 'hello', userId: 'u1' },
    thread: { threadId: 't1', sessionScope: 'scope1' },
    memory: {
      dynamicPrompt: 'dynamic prompt',
      stableSystemBlocks: [{ id: 'stable', content: 'stable content' }],
      dynamicContextBlocks: [{ id: 'dynamic', content: 'dynamic content' }],
      assistantOnlyContextBlocks: [{ id: 'assistant', content: 'assistant content' }],
      promptSnapshot: {
        stableBlockIds: ['stable'],
        dynamicBlockIds: ['dynamic'],
        assistantOnlyBlockIds: ['assistant'],
        cacheFriendlyFingerprint: 'fp1',
        cacheMeta: { hit: true },
        freshness: { sessionContext: 'fresh' },
        dynamicPromptPlan: { enabledBlockIds: ['dynamic'] },
        assembledBlocks: [{ id: 'heavy_block', content: 'x'.repeat(5000) }],
        renderedSystemMessages: [{ role: 'system', content: 'x'.repeat(5000) }],
        budgetReport: { blocks: [{ id: 'heavy_budget' }] }
      },
      promptSegments: {
        cacheMeta: { hit: true },
        freshness: { sessionContext: 'fresh' },
        securityLabels: ['safe'],
        activatedPersonaModules: ['module_a'],
        personaModuleCandidates: ['module_a', 'module_b'],
        systemPrompt: [{ role: 'system', content: 'x'.repeat(5000) }],
        assembledBlocks: [{ id: 'heavy_segment', content: 'x'.repeat(5000) }],
        stableSystemBlocks: [{ id: 'stable', content: 'x'.repeat(5000) }]
      },
      preparedMainConversationContext: {
        messages: [{ role: 'system', content: 'x'.repeat(5000) }],
        mainConversationSnapshot: { segments: [{ text: 'x'.repeat(5000) }] }
      },
      mainConversationMessages: [{ role: 'system', content: 'x'.repeat(5000) }],
      assistantOnlyContextMessagesPrepared: [{ role: 'system', content: 'x'.repeat(5000) }],
      canonicalSegmentsPrepared: { items: ['heavy'] },
      compactionPlanPrepared: { items: ['heavy'] },
      mainConversationSnapshot: {
        segments: [{ text: 'x'.repeat(5000) }],
        snapshotMeta: {
          compactionDiagnostics: {
            usageRatio: 0.42,
            level: 'normal'
          }
        }
      },
      contextStats: { usageRatio: 0.5, compactionLevel: 'tight' },
      mainConversationSnapshotSignature: 'sig1',
      statusBarVariableSnapshot: {
        relationship: { affection: 33 },
        character: { mood: 12 }
      },
      context: { retrieved: true },
      continuityState: {
        payload: { active_topic: 'topic' },
        text: 'continuity'
      },
      globalToolEvidence: 'evidence',
      globalToolResults: [{ ok: true }]
    },
    plan: { steps: [] },
    execution: {
      status: 'completed',
      agent: {
        initialized: true,
        completed: false,
        pendingToolCalls: [{
          index: 0,
          round: 2,
          toolCallId: 'call_2',
          toolName: 'web_search',
          withinBudget: true,
          toolCall: {
            id: 'call_2',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"hello"}' }
          }
        }],
        toolRoundCount: 2,
        toolCallCount: 3,
        toolHistory: [{
          fingerprint: 'web_search:{"query":"hello"}',
          envelope: {
            tool_call_id: 'call_1',
            tool_name: 'web_search',
            status: 'completed',
            result: 'result'
          }
        }],
        completedToolCallIds: ['call_1'],
        forceFinal: true,
        forceFinalAfterTools: false,
        stopReason: 'tool_round_limit_reached'
      }
    },
    output: { finalReply: 'reply', displayReply: 'reply' },
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' }
    ]
  };

  const snapshot = snapshotState(state);

  assert.strictEqual(snapshot.memory.checkpointCompacted, true);
  assert.strictEqual(snapshot.memory.preparedMainConversationContext, undefined);
  assert.strictEqual(snapshot.memory.mainConversationMessages, undefined);
  assert.strictEqual(snapshot.memory.assistantOnlyContextMessagesPrepared, undefined);
  assert.strictEqual(snapshot.memory.canonicalSegmentsPrepared, undefined);
  assert.strictEqual(snapshot.memory.compactionPlanPrepared, undefined);
  assert.strictEqual(snapshot.memory.mainConversationSnapshot, undefined);
  assert.strictEqual(snapshot.memory.mainConversationSnapshotSignature, undefined);
  assert.strictEqual(snapshot.memory.statusBarVariableSnapshot, undefined);
  assert.strictEqual(snapshot.memory.promptSnapshot.assembledBlocks, undefined);
  assert.strictEqual(snapshot.memory.promptSnapshot.renderedSystemMessages, undefined);
  assert.strictEqual(snapshot.memory.promptSnapshot.budgetReport, undefined);
  assert.strictEqual(snapshot.memory.promptSegments.systemPrompt, undefined);
  assert.strictEqual(snapshot.memory.promptSegments.assembledBlocks, undefined);
  assert.strictEqual(snapshot.memory.promptSegments.stableSystemBlocks, undefined);
  assert.deepStrictEqual(snapshot.memory.contextStats, { usageRatio: 0.5, compactionLevel: 'tight' });
  assert.strictEqual(snapshot.memory.continuityState.text, 'continuity');
  assert.deepStrictEqual(snapshot.execution.agent, state.execution.agent);
  assert.deepStrictEqual(snapshot.messages, state.messages);
  assert.strictEqual(snapshot.output.finalReply, 'reply');

  console.log('langgraphCheckpointSnapshot.test.js passed');
})();

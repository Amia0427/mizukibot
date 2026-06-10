const assert = require('assert');

const { createConversationContextHelpers } = require('../api/runtimeV2/runtime/conversationContext');

function identity(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

module.exports = (() => {
  const helpers = createConversationContextHelpers({
    config: {
      AI_MODEL: 'claude-3-5-sonnet-latest',
      CONTINUITY_STATE_PROMPT_ENABLED: true
    },
    normalizeToolNames: identity,
    filterAllowedToolsForMemoryCliTurn: identity,
    mergeAllowedToolsWithMemoryCli: identity,
    isPlannerSingleAuthorityEnabled: () => false,
    getRouteToolPlanner: () => null,
    resolveModelTokenLimit: (_model, fallback) => fallback,
    buildSecuritySystemPrompt: () => 'security'
  });

  const state = {
    request: {},
    memory: {
      stableSystemBlocks: [
        { id: 'main_persona_system', content: 'persona stable' },
        { id: 'continuity_state', content: '[ContinuityState]\nvolatile' }
      ],
      dynamicContextBlocks: [
        { id: 'affinity_level', content: '[Affinity]\nfriend' },
        { id: 'relationship_state', content: '[Relationship]\ntrusted' },
        { id: 'current_conversation', content: '[CurrentConversation]\nlatest turn' }
      ],
      assistantOnlyContextBlocks: [
        { id: 'dynamic_few_shot', content: 'few-shot example' },
        { id: 'assistant_hint', content: 'plain hint' }
      ],
      continuityState: {
        text: '[ContinuityState]\nvolatile',
        payload: {}
      }
    }
  };

  const systemMessages = helpers.getMainConversationSystemMessages(state);
  const stableSystem = systemMessages.find((item) => String(item.content?.[0]?.text || item.content || '').includes('persona stable'));
  const affinityMessage = systemMessages.find((item) => String(item.content?.[0]?.text || item.content || '').includes('[Affinity]'));
  const relationshipMessage = systemMessages.find((item) => String(item.content?.[0]?.text || item.content || '').includes('[Relationship]'));
  const continuityMessage = systemMessages.find((item) => String(item.content || '').includes('[ContinuityState]'));
  const currentConversationMessage = systemMessages.find((item) => String(item.content || '').includes('[CurrentConversation]'));

  assert.deepStrictEqual(stableSystem.content[0].cache_control, { type: 'ephemeral', ttl: '5m' });
  assert.strictEqual(typeof affinityMessage.content, 'string');
  assert.strictEqual(typeof relationshipMessage.content, 'string');
  assert.strictEqual(typeof continuityMessage.content, 'string');
  assert.strictEqual(typeof currentConversationMessage.content, 'string');

  const activeTopicOnlyState = {
    request: {},
    memory: {
      stableSystemBlocks: [
        { id: 'main_persona_system', content: 'persona stable' }
      ],
      dynamicContextBlocks: [],
      assistantOnlyContextBlocks: [],
      promptSnapshot: {
        dynamicPromptPlan: {
          enabledBlockIds: []
        }
      },
      continuityState: {
        text: '[ContinuityState]\n[ActiveTopic] old joke topic',
        payload: {
          active_topic: 'old joke topic'
        }
      }
    }
  };
  const activeTopicOnlyMessages = helpers.getMainConversationSystemMessages(activeTopicOnlyState);
  assert.ok(
    !activeTopicOnlyMessages.some((item) => String(item.content || '').includes('[ContinuityState]')),
    'active_topic alone should not force ContinuityState into the main prompt'
  );

  activeTopicOnlyState.memory.promptSnapshot.dynamicPromptPlan.enabledBlockIds = ['continuity_state'];
  const plannerEnabledMessages = helpers.getMainConversationSystemMessages(activeTopicOnlyState);
  assert.ok(
    plannerEnabledMessages.some((item) => String(item.content || '').includes('[ContinuityState]')),
    'planner-selected continuity_state should still be included'
  );

  const assistantOnly = helpers.buildAssistantOnlyContextMessages(state);
  const fewShot = assistantOnly.find((item) => item.content === 'few-shot example');
  const hint = assistantOnly.find((item) => item.content === 'plain hint');
  assert.strictEqual(typeof fewShot.content, 'string');
  assert.strictEqual(typeof hint.content, 'string');

  console.log('conversationContextClaudeCacheMarkers.test.js passed');
})();

const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

function plannerResponse(payload = {}) {
  return {
    data: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify(payload)
          }
        }
      ]
    }
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    Object.assign(process.env, {
      BOT_TOOL_MODE: 'full',
      PLAN_API_BASE_URL: 'https://planner.example.test/v1',
      PLAN_API_KEY: 'planner-key',
      PLAN_MODEL: 'planner-model',
      PLANNER_MAX_MODEL_CALLS: '2',
      PLANNER_SEMANTIC_REFINE_ENABLED: 'true',
      PLANNER_SEMANTIC_CONFIDENCE_THRESHOLD: '0.72',
      PLANNER_SUBAGENT_ENABLED: '0',
      MEMOS_MCP_ENABLED: 'false'
    });

    clearProjectCache();

    const httpClient = require('../src/model/http');
    const calls = [];
    httpClient.postWithRetry = async (url, body, retries, apiKey) => {
      calls.push({ url, body, retries, apiKey });
      if (calls.length === 1) {
        return plannerResponse({
          mode: 'chat_only',
          taskShape: 'fast_reply',
          allowedToolNames: [],
          steps: [],
          plannerMeta: {
            decisionVersion: 'planner_decision_v2',
            plannerVersion: 'direct_chat_single_authority_v2',
            reason: 'too broad first pass',
            plannerModel: 'mock-planner',
            decisionSource: 'planner',
            semanticConfidence: 0.41,
            needsSemanticRefinement: true,
            semanticAssessment: {
              intentSummary: 'user asks for current official docs',
              sourceScope: 'web',
              contextDependencies: [],
              ambiguity: ['tool evidence not selected'],
              confidence: 0.41,
              needsRefinement: true
            }
          }
        });
      }
      return plannerResponse({
        mode: 'tool_plan',
        taskShape: 'tool_augmented_reply',
        allowedToolNames: ['web_search', 'web_fetch'],
        steps: [
          {
            id: 'planner_step_1',
            tool: 'web_search',
            args: { query: 'OpenAI official docs planner API' },
            purpose: 'Find official docs'
          },
          {
            id: 'planner_step_2',
            tool: 'web_fetch',
            args: { url: '' },
            dependsOn: ['planner_step_1'],
            purpose: 'Fetch the best official result'
          }
        ],
        plannerMeta: {
          decisionVersion: 'planner_decision_v2',
          plannerVersion: 'direct_chat_single_authority_v2',
          reason: 'refined to web evidence',
          plannerModel: 'mock-planner',
          decisionSource: 'planner',
          semanticConfidence: 0.91,
          needsSemanticRefinement: false,
          semanticAssessment: {
            intentSummary: 'current official docs summary',
            sourceScope: 'web',
            contextDependencies: [],
            ambiguity: [],
            confidence: 0.91,
            needsRefinement: false
          }
        }
      });
    };

    const { planRequestV2 } = require('../api/runtimeV2/planning/service');
    const decision = await planRequestV2({
      question: '帮我找 OpenAI 官方 docs 并总结重点',
      cleanText: '帮我找 OpenAI 官方 docs 并总结重点',
      topRouteType: 'direct_chat',
      routeMeta: {
        chatMode: 'chat',
        toolIntent: 'force_tools',
        responseIntent: 'summary'
      },
      route: {
        question: '帮我找 OpenAI 官方 docs 并总结重点',
        cleanText: '帮我找 OpenAI 官方 docs 并总结重点',
        topRouteType: 'direct_chat',
        meta: {
          chatMode: 'chat',
          toolIntent: 'force_tools',
          responseIntent: 'summary'
        },
        intent: {},
        facets: {
          sourceScope: 'web',
          freshness: 'latest'
        }
      },
      allowedTools: ['web_search', 'web_fetch'],
      config: {
        MEMOS_MCP_ENABLED: false,
        PLANNER_MAX_MODEL_CALLS: 2,
        PLANNER_SEMANTIC_REFINE_ENABLED: true,
        PLANNER_SEMANTIC_CONFIDENCE_THRESHOLD: 0.72
      }
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].retries, 0);
    const firstPayload = JSON.parse(calls[0].body.messages[1].content);
    assert.ok(firstPayload.semanticContext);
    assert.strictEqual(firstPayload.semanticContext.toolDecisionHints.sourceScope, 'web');
    assert.ok(!Object.prototype.hasOwnProperty.call(firstPayload, 'semanticRefinement'));

    assert.strictEqual(decision.mode, 'chat_only');
    assert.deepStrictEqual(decision.allowedToolNames, []);
    assert.strictEqual(decision.steps.length, 0);
    assert.strictEqual(decision.plannerMeta.semanticConfidence, 0.41);
    assert.strictEqual(decision.plannerMeta.needsSemanticRefinement, true);
    assert.strictEqual(decision.plannerMeta.semanticRefinement.totalModelCalls, 1);
    assert.strictEqual(decision.plannerMeta.semanticRefinement.maxModelCalls, 1);
    assert.strictEqual(decision.plannerMeta.semanticRefinement.refined, false);
    assert.deepStrictEqual(decision.plannerMeta.semanticRefinement.attempts.map((item) => item.attempt), [1]);
    assert.ok(decision.plannerMeta.semanticRefinement.triggerReasons.includes('requested_semantic_refinement'));
    assert.ok(decision.plannerMeta.semanticRefinement.triggerReasons.includes('low_semantic_confidence'));

    console.log('plannerSemanticRefine.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

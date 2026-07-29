const assert = require('assert');

module.exports = (async () => {
  const { createPrivateProactiveModelClient } = require('../core/privateProactiveEngine/model');
  let captured = null;
  const client = createPrivateProactiveModelClient({
    API_BASE_URL: 'https://main.example/v1/chat/completions',
    API_KEY: 'main-key',
    AI_MODEL: 'main-model',
    ADMIN_API_BASE_URL: 'https://admin.example/v1/chat/completions',
    ADMIN_API_KEY: 'admin-key',
    ADMIN_AI_MODEL: 'admin-model',
    INITIATIVE_DECISION_API_BASE_URL: 'https://initiative.example/v1/chat/completions',
    INITIATIVE_DECISION_API_KEY: 'initiative-key',
    INITIATIVE_DECISION_MODEL: 'initiative-model',
    SYSTEM_PROMPT: '你是测试角色。'
  }, {
    postWithRetry: async (url, body, retries, key) => {
      captured = { url, body, retries, key };
      return {
        data: {
          choices: [{
            message: {
              role: 'assistant',
              content: '{"send":false,"reason":"不打扰","messages":[]}'
            }
          }]
        }
      };
    }
  });

  const result = await client({
    kind: 'proactive',
    userId: 'u1',
    context: { privateHistory: [] }
  });
  assert.deepStrictEqual(result, { send: false, reason: '不打扰', messages: [] });
  assert.strictEqual(captured.url, 'https://main.example/v1/chat/completions');
  assert.strictEqual(captured.key, 'main-key');
  assert.strictEqual(captured.body.model, 'main-model');
  assert.strictEqual(captured.body.stream, false);
  assert.strictEqual(captured.retries, 0);
  assert.strictEqual(captured.body.tools, undefined, '主动私聊模型不能获得工具');
  assert.strictEqual(captured.body.__trace.userRole, 'system', '主动预算不能占普通用户额度');
  assert.strictEqual(captured.body.__trace.modelSource, 'AI_MODEL');
  assert.strictEqual(captured.body.__trace.apiBaseUrlSource, 'API_BASE_URL');
  assert.strictEqual(captured.body.__trace.apiKeySource, 'API_KEY');
  assert.ok(!captured.url.includes('admin'));
  assert.notStrictEqual(captured.body.model, 'admin-model');
  assert.notStrictEqual(captured.body.model, 'initiative-model');

  console.log('privateProactiveModelConfig.test.js passed');
})();

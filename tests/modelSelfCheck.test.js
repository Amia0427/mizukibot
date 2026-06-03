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

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    Object.assign(process.env, {
      API_BASE_URL: 'https://main.example/v1/chat/completions',
      API_KEY: 'main-key',
      AI_MODEL: 'main-model',
      ADMIN_USER_IDS: 'admin_1',
      ADMIN_API_BASE_URL: 'https://admin.example/v1/chat/completions',
      ADMIN_API_KEY: 'admin-key',
      ADMIN_AI_MODEL: 'admin-model',
      PLAN_API_BASE_URL: 'https://plan.example/v1',
      PLAN_API_KEY: 'plan-key',
      PLAN_MODEL: 'plan-model',
      MEMORY_API_BASE_URL: 'https://memory.example/v1',
      MEMORY_API_KEY: 'memory-key',
      MEMORY_MODEL: 'memory-model',
      MEMORY_EMBEDDING_ENABLED: '1',
      MEMORY_EMBEDDING_MODEL: 'embedding-model',
      MEMORY_EMBEDDING_API_BASE_URL: 'https://embedding.example/v1',
      MEMORY_EMBEDDING_API_KEY: 'embedding-key',
      MEMORY_RERANK_ENABLED: '1',
      MEMORY_RERANK_MODEL: 'rerank-model',
      MEMORY_RERANK_API_BASE_URL: 'https://rerank.example/v1',
      MEMORY_RERANK_API_KEY: 'rerank-key',
      PASSIVE_AWARENESS_DECISION_ENABLED: '1',
      PASSIVE_AWARENESS_API_BASE_URL: 'https://passive-decision.example/v1',
      PASSIVE_AWARENESS_API_KEY: 'passive-decision-key',
      PASSIVE_AWARENESS_MODEL: 'passive-decision-model',
      PASSIVE_AWARENESS_REPLY_API_BASE_URL: 'https://passive-reply.example/v1',
      PASSIVE_AWARENESS_REPLY_API_KEY: 'passive-reply-key',
      PASSIVE_AWARENESS_REPLY_MODEL: 'passive-reply-model',
      MODEL_SELF_CHECK_TIMEOUT_MS: '1200'
    });

    clearProjectCache();

    const httpClient = require('../api/httpClient');
    const calls = [];
    httpClient.postWithRetry = async (url, body, retries, apiKey) => {
      calls.push({ url, body, retries, apiKey });
      if (body?.model === 'rerank-model') {
        const error = new Error('upstream timeout after 1200ms');
        error.code = 'ETIMEDOUT';
        throw error;
      }
      if (body?.model === 'memory-model') {
        throw new Error('provider internal detail should not leak');
      }
      return { data: { choices: [{ message: { content: 'ok' } }], data: [{ embedding: [1] }], results: [{ index: 0, score: 1 }] } };
    };

    const {
      clampTimeoutMs,
      buildSelfCheckSpecs,
      formatModelSelfCheckReport,
      runModelSelfCheck
    } = require('../utils/modelSelfCheck');
    assert.strictEqual(clampTimeoutMs('not-a-number'), 25000);

    const specs = buildSelfCheckSpecs({ adminUserId: 'admin_1', normalUserId: 'user_1' });
    assert.deepStrictEqual(specs.map((item) => item.type), [
      'plan',
      'embedding',
      'rerank',
      'memory',
      'main_reply',
      'admin_reply',
      'passive_awareness_decision',
      'passive_awareness_reply'
    ]);
    assert.strictEqual(specs[0].url, 'https://plan.example/v1/chat/completions');
    assert.strictEqual(specs[0].body.max_tokens, 8);
    assert.strictEqual(specs[0].body.stream, false);
    assert.deepStrictEqual(specs[1].body.input, ['ok']);
    assert.deepStrictEqual(specs[2].body.documents, ['ok', 'ping']);
    assert.strictEqual(specs[2].body.top_n, 1);
    assert.strictEqual(specs[4].model, 'main-model');
    assert.strictEqual(specs[5].model, 'admin-model');
    assert.ok(!specs[4].body.reasoning_effort);
    assert.ok(!Object.prototype.hasOwnProperty.call(specs[4].body, 'top_a'));
    assert.ok(!Object.prototype.hasOwnProperty.call(specs[4].body, 'repetition_penalty'));
    assert.ok(!Object.prototype.hasOwnProperty.call(specs[4].body, 'prompt_cache_key'));
    assert.ok(!specs[5].body.reasoning_effort);
    assert.ok(!Object.prototype.hasOwnProperty.call(specs[5].body, 'top_a'));
    assert.ok(!Object.prototype.hasOwnProperty.call(specs[5].body, 'repetition_penalty'));
    assert.ok(!Object.prototype.hasOwnProperty.call(specs[5].body, 'prompt_cache_key'));
    assert.strictEqual(specs[6].url, 'https://passive-decision.example/v1/chat/completions');
    assert.strictEqual(specs[6].model, 'passive-decision-model');
    assert.strictEqual(specs[6].body.max_tokens, 8);
    assert.strictEqual(specs[6].body.stream, false);
    assert.strictEqual(specs[6].body.__preferredProtocol, 'chat_completions');
    assert.strictEqual(specs[7].url, 'https://passive-reply.example/v1/chat/completions');
    assert.strictEqual(specs[7].model, 'passive-reply-model');
    assert.strictEqual(specs[7].body.max_tokens, 8);
    assert.strictEqual(specs[7].body.stream, false);
    assert.strictEqual(specs[7].body.__preferredProtocol, 'chat_completions');

    const results = await runModelSelfCheck({ adminUserId: 'admin_1', normalUserId: 'user_1' });
    assert.strictEqual(calls.length, 8);
    assert.ok(calls.every((call) => call.retries === 0));
    assert.ok(calls.every((call) => Number(call.body.__timeoutMs) >= 1000));
    assert.strictEqual(results.find((item) => item.type === 'rerank').status, 'timeout');
    assert.strictEqual(results.find((item) => item.type === 'rerank').timedOut, true);
    assert.strictEqual(results.find((item) => item.type === 'memory').status, 'failed');
    assert.strictEqual(results.find((item) => item.type === 'memory').timedOut, false);

    const report = formatModelSelfCheckReport(results);
    assert.ok(report.includes('模型自检:'));
    assert.ok(report.includes('rerank | rerank-model |'));
    assert.ok(report.includes('passive_awareness_decision | passive-decision-model |'));
    assert.ok(report.includes('passive_awareness_reply | passive-reply-model |'));
    assert.ok(report.includes('timeout=true'));
    assert.ok(!report.includes('provider internal detail'));
    assert.ok(!report.includes('https://'));
    assert.ok(!report.includes('main-key'));
    assert.ok(!report.includes('passive-decision-key'));

    process.env.PASSIVE_AWARENESS_REPLY_API_BASE_URL = 'https://passive-reply.example/v1';
    process.env.PASSIVE_AWARENESS_REPLY_API_KEY = 'passive-reply-key';
    process.env.PASSIVE_AWARENESS_REPLY_MODEL = 'passive-reply-model';
    delete process.env.PASSIVE_AWARENESS_REPLY_USE_MAIN_MODEL;
    clearProjectCache();
    const defaultDedicatedSelfCheck = require('../utils/modelSelfCheck');
    const defaultDedicatedSpecs = defaultDedicatedSelfCheck.buildSelfCheckSpecs({ adminUserId: 'admin_1', normalUserId: 'user_1' });
    assert.strictEqual(defaultDedicatedSpecs.find((item) => item.type === 'passive_awareness_reply').url, 'https://passive-reply.example/v1/chat/completions');
    assert.strictEqual(defaultDedicatedSpecs.find((item) => item.type === 'passive_awareness_reply').model, 'passive-reply-model');

    process.env.PASSIVE_AWARENESS_REPLY_USE_MAIN_MODEL = 'true';
    process.env.MEMORY_EMBEDDING_ENABLED = '0';
    process.env.MEMORY_RERANK_ENABLED = '0';
    process.env.PASSIVE_AWARENESS_DECISION_ENABLED = '0';
    process.env.PASSIVE_AWARENESS_REPLY_API_BASE_URL = ' ';
    process.env.PASSIVE_AWARENESS_REPLY_API_KEY = ' ';
    process.env.PASSIVE_AWARENESS_REPLY_MODEL = ' ';
    clearProjectCache();
    const disabledHttpClient = require('../api/httpClient');
    disabledHttpClient.postWithRetry = async (url, body, retries, apiKey) => {
      calls.push({ url, body, retries, apiKey });
      return { data: { choices: [{ message: { content: 'ok' } }] } };
    };
    const disabledSelfCheck = require('../utils/modelSelfCheck');
    const disabledSpecs = disabledSelfCheck.buildSelfCheckSpecs({ adminUserId: 'admin_1', normalUserId: 'user_1' });
    assert.strictEqual(disabledSpecs.find((item) => item.type === 'embedding').url, '');
    assert.strictEqual(disabledSpecs.find((item) => item.type === 'rerank').url, '');
    assert.strictEqual(disabledSpecs.find((item) => item.type === 'passive_awareness_decision').url, '');
    assert.strictEqual(disabledSpecs.find((item) => item.type === 'passive_awareness_reply').url, 'https://main.example/v1/chat/completions');
    assert.strictEqual(disabledSpecs.find((item) => item.type === 'passive_awareness_reply').model, 'main-model');

    console.log('modelSelfCheck.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

const assert = require('assert');
const fs = require('fs');
const os = require('os');
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

function readJsonLines(filePath = '') {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-route-model-diag-'));
  let axios = null;
  let originalPost = null;

  try {
    process.env.DATA_DIR = tempDir;
    process.env.API_KEY = 'wrong-key';
    process.env.API_BASE_URL = 'https://example.com/wrong-provider/v1/chat/completions';
    process.env.AI_MODEL = 'wrong-model';
    process.env.AI_RETRIES = '0';
    process.env.AI_FALLBACK_ENABLED = 'false';
    process.env.ADMIN_AI_FALLBACK_ENABLED = 'false';
    process.env.HUMANIZER_AGENT_ENABLED = 'false';

    clearProjectCache();
    axios = require('axios');
    originalPost = axios.post;

    const { requestAssistantMessage } = require('../api/runtimeV2/model/service');
    const { createRequestTrace, resetRequestTraceStateForTests } = require('../utils/requestTrace');
    const { resetModelCallTracker } = require('../utils/modelCallTracker');

    resetRequestTraceStateForTests();
    resetModelCallTracker();

    axios.post = async () => {
      const error = new Error('upstream model quota exceeded');
      error.response = {
        status: 429,
        data: {
          error: {
            message: 'upstream model quota exceeded'
          }
        }
      };
      throw error;
    };

    const trace = createRequestTrace({
      source: 'message_ingress',
      messageId: 'm-openclaude',
      groupId: 'g1',
      userId: 'u1',
      chatType: 'group'
    });

    await assert.rejects(
      () => requestAssistantMessage([{ role: 'user', content: 'hello' }], {
        userId: 'u1',
        routePolicyKey: 'chat/default',
        routeDebugKey: 'direct_chat/text_chat/answer',
        topRouteType: 'direct_chat',
        dispatchBranch: 'direct_reply',
        triggerBranch: 'direct_reply.final_send',
        requestTrace: trace,
        routeMeta: {
          requestTrace: trace,
          routePolicyKey: 'chat/default',
          routeDebugKey: 'direct_chat/text_chat/answer',
          topRouteType: 'direct_chat',
          routeFallbackReason: 'expected_openclaudecode_mapping'
        }
      }),
      /upstream model quota exceeded/
    );

    const traceEvents = readJsonLines(path.join(tempDir, 'request-trace.ndjson'));
    const httpFailure = traceEvents.find((event) => event.stage === 'http_client_failure');
    assert.ok(httpFailure, 'http failure trace should be written');
    assert.strictEqual(httpFailure.routeDebugKey, 'direct_chat/text_chat/answer');
    assert.strictEqual(httpFailure.routePolicyKey, 'chat/default');
    assert.strictEqual(httpFailure.topRouteType, 'direct_chat');
    assert.strictEqual(httpFailure.dispatchBranch, 'direct_reply');
    assert.strictEqual(httpFailure.triggerBranch, 'direct_reply.final_send');
    assert.strictEqual(httpFailure.apiBaseUrlHost, 'example.com');
    assert.strictEqual(httpFailure.model, 'wrong-model');
    assert.strictEqual(httpFailure.modelSource, 'AI_MODEL');
    assert.strictEqual(httpFailure.apiBaseUrlSource, 'API_BASE_URL');
    assert.strictEqual(httpFailure.fallbackReason, 'expected_openclaudecode_mapping');
    assert.strictEqual(httpFailure.finalErrorCode, 'http_429');

    const modelCalls = readJsonLines(path.join(tempDir, 'model-calls.ndjson'));
    const failedCall = modelCalls.find((event) => event.status === 'failed');
    assert.ok(failedCall, 'failed model call should be written');
    assert.strictEqual(failedCall.route_debug_key, 'direct_chat/text_chat/answer');
    assert.strictEqual(failedCall.route_policy_key, 'chat/default');
    assert.strictEqual(failedCall.dispatch_branch, 'direct_reply');
    assert.strictEqual(failedCall.api_base_url_host, 'example.com');
    assert.strictEqual(failedCall.model, 'wrong-model');
    assert.strictEqual(failedCall.final_error_code, 'http_429');
    assert.strictEqual(failedCall.model_route_diagnostic.apiBaseUrlHost, 'example.com');

    console.log('mainReplyRouteModelDiagnostics.test.js passed');
  } finally {
    if (axios && originalPost) axios.post = originalPost;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

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

function findScenario(report, name) {
  return (report.scenarios || []).find((item) => item.name === name);
}

function findRemoved(strippedFields, field) {
  const items = [
    ...(strippedFields?.cache || []),
    ...(strippedFields?.internal || [])
  ];
  return items.find((item) => item.field === field)?.removed || 0;
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  try {
    const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.54 Safari/537.36';
    process.env.API_KEY = 'diagnostic-test-key';
    process.env.API_BASE_URL = 'https://main.example/v1/chat/completions';
    process.env.AI_MODEL = 'main-model';
    process.env.OPENAI_PROMPT_CACHE_ENABLED = 'true';
    process.env.OPENAI_PROMPT_CACHE_RETENTION = '24h';
    process.env.MODEL_HTTP_USER_AGENT = browserUA;
    process.env.GEMINI_SYSTEM_PROMPT_PATH = path.join(__dirname, 'fixtures', 'gemini-system-prompt.txt');
    clearProjectCache();

    const { runProviderRequestDiagnostics } = require('../utils/providerRequestDiagnostics');

    const openaiReport = await runProviderRequestDiagnostics({
      provider: 'openai_compatible',
      scenarios: 'http_client_direct'
    });
    const openaiDirect = findScenario(openaiReport, 'http_client_direct');
    assert.ok(openaiDirect);
    assert.strictEqual(openaiDirect.finalProvider, 'openai_compatible');
    assert.strictEqual(openaiDirect.auth.header, 'Authorization');
    assert.ok(openaiDirect.headerNames.includes('User-Agent'));
    assert.ok(openaiDirect.headerNames.includes('sec-ch-ua'));
    assert.strictEqual(openaiDirect.headers['User-Agent'], browserUA);
    assert.ok(openaiDirect.headerNames.includes('Authorization'));
    assert.ok(!openaiDirect.headerNames.includes('x-goog-api-key'));
    assert.strictEqual(openaiDirect.cache.openaiPromptCacheKey, 'provider-diagnostic-cache-key');
    assert.strictEqual(openaiDirect.cache.openaiPromptCacheRetention, '24h');
    assert.strictEqual(findRemoved(openaiDirect.strippedFields, 'prompt_cache_key'), 0);
    assert.strictEqual(findRemoved(openaiDirect.strippedFields, 'prompt_cache_retention'), 0);
    assert.ok(findRemoved(openaiDirect.strippedFields, 'cache_control') > 0);
    assert.ok(openaiDirect.anomalies.includes('openai_prompt_cache_and_cache_control_both_present'));

    const geminiReport = await runProviderRequestDiagnostics({
      provider: 'gemini_native',
      scenarios: 'http_client_direct'
    });
    const geminiDirect = findScenario(geminiReport, 'http_client_direct');
    assert.ok(geminiDirect);
    assert.strictEqual(geminiDirect.finalProvider, 'gemini_native');
    assert.strictEqual(geminiDirect.auth.header, 'x-goog-api-key');
    assert.strictEqual(geminiDirect.headers['User-Agent'], browserUA);
    assert.ok(geminiDirect.headerNames.includes('sec-ch-ua-platform'));
    assert.ok(!geminiDirect.headerNames.includes('Authorization'));
    assert.ok(geminiDirect.headerNames.includes('x-goog-api-key'));
    assert.strictEqual(geminiDirect.cache.openaiPromptCacheKey, '');
    assert.strictEqual(geminiDirect.cache.openaiPromptCacheRetention, '');
    assert.strictEqual(geminiDirect.cache.anthropicCacheBreakpoints, 0);
    assert.ok(findRemoved(geminiDirect.strippedFields, 'prompt_cache_key') > 0);
    assert.ok(findRemoved(geminiDirect.strippedFields, 'prompt_cache_retention') > 0);
    assert.ok(findRemoved(geminiDirect.strippedFields, 'cache_control') > 0);
    assert.strictEqual(geminiDirect.geminiSystemInstruction.present, true);
    assert.strictEqual(geminiDirect.geminiSystemInstruction.hasGeminiRuntimeAdapter, true);
    assert.ok(geminiDirect.geminiSystemInstruction.chars > 0);
    assert.deepStrictEqual(geminiDirect.anomalies, []);

    process.env.API_PROVIDER = 'openai_compatible';
    process.env.API_BASE_URL = 'https://gcli.example/v1/chat/completions';
    process.env.AI_MODEL = 'gemini-3-flash-preview';
    clearProjectCache();
    const { runProviderRequestDiagnostics: runGatewayDiagnostics } = require('../utils/providerRequestDiagnostics');
    const gatewayReport = await runGatewayDiagnostics({
      scenarios: 'main_reply'
    });
    const gatewayMain = findScenario(gatewayReport, 'main_reply');
    assert.ok(gatewayMain);
    assert.strictEqual(gatewayReport.requested.provider, 'openai_compatible');
    assert.strictEqual(gatewayMain.finalProvider, 'openai_compatible');
    assert.strictEqual(gatewayMain.requestUrl, 'https://gcli.example/v1/chat/completions');
    assert.ok(gatewayMain.headerNames.includes('Authorization'));
    assert.ok(!gatewayMain.headerNames.includes('x-goog-api-key'));
    assert.deepStrictEqual(gatewayMain.anomalies, []);

    process.env.API_PROVIDER = '';
    process.env.API_BASE_URL = 'https://main.example/v1/chat/completions';
    process.env.AI_MODEL = 'main-model';
    clearProjectCache();
    const { runProviderRequestDiagnostics: runAnthropicDiagnostics } = require('../utils/providerRequestDiagnostics');
    const anthropicReport = await runAnthropicDiagnostics({
      provider: 'anthropic',
      scenarios: 'http_client_direct'
    });
    const anthropicDirect = findScenario(anthropicReport, 'http_client_direct');
    assert.ok(anthropicDirect);
    assert.strictEqual(anthropicDirect.finalProvider, 'anthropic');
    assert.strictEqual(anthropicDirect.auth.header, 'x-api-key');
    assert.strictEqual(anthropicDirect.headers['User-Agent'], browserUA);
    assert.ok(anthropicDirect.headerNames.includes('Sec-Fetch-Mode'));
    assert.ok(!anthropicDirect.headerNames.includes('Authorization'));
    assert.strictEqual(anthropicDirect.cache.openaiPromptCacheKey, '');
    assert.strictEqual(anthropicDirect.cache.openaiPromptCacheRetention, '');
    assert.ok(anthropicDirect.cache.anthropicCacheBreakpoints > 0);
    assert.ok(findRemoved(anthropicDirect.strippedFields, 'prompt_cache_key') > 0);
    assert.ok(findRemoved(anthropicDirect.strippedFields, 'prompt_cache_retention') > 0);
    assert.deepStrictEqual(anthropicDirect.anomalies, []);

    console.log('providerRequestDiagnostics.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

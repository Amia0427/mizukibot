const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
try {
  const snapshot = { ...process.env };
  process.env.API_KEY = 'main-key';
  process.env.API_BASE_URL = 'https://example.com/main/v1/chat/completions';
  process.env.AI_MODEL = 'main-model';
  process.env.ADMIN_USER_IDS = 'admin-1';
  process.env.ADMIN_AI_MODEL = 'admin-model';
  process.env.ADMIN_API_BASE_URL = 'https://example.com/admin/v1/messages';
  process.env.ADMIN_API_KEY = 'admin-key';
  process.env.ADMIN_AI_FALLBACK_ENABLED = 'true';
  process.env.ADMIN_AI_FALLBACK_MODEL = 'admin-fallback-model';
  process.env.ADMIN_AI_FALLBACK_API_BASE_URL = 'https://example.com/admin-fallback/v1/messages';
  process.env.ADMIN_AI_FALLBACK_API_KEY = 'admin-fallback-key';
  process.env.MAIN_MODEL_ANTHROPIC_WEB_SEARCH_ENABLED = 'false';
  clearProjectCache();

  const {
    inferNoToolWebCapability,
    inspectProviderSearchEvidence,
    parseArgs,
    runDiagnose
  } = require('../scripts/diagnose-main-model-web-search');

  const noBrowse = inferNoToolWebCapability('我没有模型内置的联网搜索能力，无法实时访问互联网。');
  assert.strictEqual(noBrowse.canary, 'explicit_no_browsing');
  assert.strictEqual(noBrowse.likelyBuiltInWebSearch, false);

  const cited = inferNoToolWebCapability('I searched the web and found https://www.reuters.com/world/');
  assert.strictEqual(cited.canary, 'claims_or_cites_web');
  assert.strictEqual(cited.likelyBuiltInWebSearch, true);

  const evidence = inspectProviderSearchEvidence(
    { data: { output: [{ type: 'web_search_call' }] } },
    'source https://www.reuters.com/world/'
  );
  assert.strictEqual(evidence.providerSearchEvidence, true);
  assert.strictEqual(evidence.hasOpenAISearchCall, true);

  const urlOnlyEvidence = inspectProviderSearchEvidence(
    { data: { content: [{ type: 'text', text: 'source https://www.reuters.com/world/' }] } },
    ''
  );
  assert.strictEqual(urlOnlyEvidence.providerSearchEvidence, false);
  assert.strictEqual(urlOnlyEvidence.hasUrl, true);

  const anthropicEvidence = inspectProviderSearchEvidence(
    {
      data: {
        content: [
          { type: 'server_tool_use', name: 'web_search' },
          { type: 'web_search_tool_result' }
        ],
        usage: { server_tool_use: { web_search_requests: 1 } }
      }
    },
    ''
  );
  assert.strictEqual(anthropicEvidence.providerSearchEvidence, true);
  assert.strictEqual(anthropicEvidence.hasAnthropicSearchCall, true);

  const parsedArgs = parseArgs(['node', 'script', '--json', '--timeout-ms=12000']);
  assert.strictEqual(parsedArgs.json, true);
  assert.strictEqual(parsedArgs.timeoutMs, 12000);

  const axios = require('axios');
  const originalPost = axios.post;
  axios.post = async (url, body) => {
    if (String(url).includes('/responses')) {
      const err = new Error('not implemented');
      err.response = { status: 500, data: { error: { message: 'not implemented' } } };
      throw err;
    }
    if (Array.isArray(body?.tools) && body.tools.some((tool) => tool?.type === 'web_search_20250305')) {
      return {
        status: 200,
        data: {
          content: [
            { type: 'server_tool_use', name: 'web_search' },
            { type: 'web_search_tool_result' },
            { type: 'text', text: 'searched https://example.com' }
          ],
          usage: { server_tool_use: { web_search_requests: 1 } }
        }
      };
    }
    return {
      status: 200,
      data: {
        choices: [
          {
            message: {
              content: '我没有模型内置的联网搜索能力。'
            }
          }
        ]
      }
    };
  };
  const result = await runDiagnose({ timeoutMs: 5000 });
  axios.post = originalPost;
  assert.strictEqual(result.targets.length, 3);
  assert.deepStrictEqual(result.targets.map((item) => item.label), [
    'main',
    'admin_main',
    'admin_main_fallback_reference'
  ]);
  assert.strictEqual(result.targets[0].probes.no_tool.inference.likelyBuiltInWebSearch, false);
  assert.strictEqual(result.targets[1].config.model, 'admin-model');
  assert.strictEqual(result.targets[2].config.model, 'admin-fallback-model');

  console.log('diagnoseMainModelWebSearch.test.js passed');

  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
  clearProjectCache();
} catch (error) {
  console.error(error);
  process.exit(1);
}
})();

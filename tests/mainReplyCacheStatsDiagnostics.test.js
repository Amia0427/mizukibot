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

module.exports = (() => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-main-reply-cache-diag-'));
  const logFile = path.join(tempDir, 'model-calls.ndjson');

  try {
    process.env.DATA_DIR = tempDir;
    clearProjectCache();

    const rows = [
      {
        ts: '2026-05-01T00:00:00.000Z',
        status: 'succeeded',
        source: 'memoryEmbeddingClient',
        provider: 'openai_compatible',
        model: 'embedding-model',
        usage: { prompt_tokens: 10 }
      },
      {
        ts: '2026-05-01T00:00:01.000Z',
        id: 'call_1',
        status: 'succeeded',
        source: 'v2_assistant_message',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        api_base_url_host: 'api.anthropic.com',
        route_debug_key: 'direct_chat/text_chat/answer',
        route_policy_key: 'chat/default',
        top_route_type: 'direct_chat',
        dispatch_branch: 'direct_reply',
        prompt_caching: {
          anthropic_beta: 'prompt-caching-2024-07-31',
          prompt_caching_beta_enabled: true,
          system_cache_breakpoints: 1,
          message_cache_breakpoints: 1,
          tool_cache_breakpoints: 1,
          total_cache_breakpoints: 3
        },
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 80,
          cache_read_input_tokens: 600,
          cache_creation_input_tokens: 200
        }
      },
      {
        ts: '2026-05-01T00:00:02.000Z',
        id: 'call_2',
        status: 'succeeded',
        source: 'v2_streaming_reply',
        provider: 'openai_compatible',
        model: 'gpt-5.4-mini',
        api_base_url_host: 'tokenflux.dev',
        route_debug_key: 'direct_chat/text_chat/answer',
        route_policy_key: 'chat/default',
        top_route_type: 'direct_chat',
        dispatch_branch: 'direct_reply',
        prompt_caching: {
          openai_prompt_cache_key: 'mizukibot:main:chat_completions:abc123',
          openai_prompt_cache_enabled: true,
          total_cache_breakpoints: 0
        },
        usage: {
          prompt_tokens: 800,
          completion_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 120
        }
      },
      {
        ts: '2026-05-01T00:00:03.000Z',
        id: 'call_3',
        status: 'succeeded',
        source: 'v2_assistant_message',
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
        api_base_url_host: 'api.anthropic.com',
        top_route_type: 'direct_chat',
        prompt_caching: {
          prompt_caching_beta_enabled: false,
          total_cache_breakpoints: 0
        },
        usage: {
          prompt_tokens: 500,
          completion_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        }
      }
    ];
    fs.writeFileSync(logFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    const {
      CACHE_STATS_SCHEMA_VERSION,
      buildCacheStatsDiagnostic
    } = require('../utils/mainReplyDiagnostics');
    const script = require('../scripts/diagnose-main-reply');
    const report = buildCacheStatsDiagnostic({ logFile, limit: 10 });
    const parsedArgs = script.parseArgs(['node', 'scripts/diagnose-main-reply.js', '--cache-stats']);

    assert.strictEqual(report.schemaVersion, CACHE_STATS_SCHEMA_VERSION);
    assert.strictEqual(parsedArgs.cacheStats, true);
    assert.strictEqual(parsedArgs.text, '');
    assert.strictEqual(report.rowsRead, 4);
    assert.strictEqual(report.mainReplyRows, 3);
    assert.strictEqual(report.latest.id, 'call_3');
    assert.strictEqual(report.latest.provider, 'anthropic');
    assert.strictEqual(report.latest.model, 'claude-3-5-haiku-latest');
    assert.strictEqual(report.latest.route, 'direct_chat');
    assert.strictEqual(report.latest.promptCache.breakpoints, 0);
    assert.ok(report.latest.signals.includes('anthropic_cache_breakpoints_zero'));
    assert.ok(report.latest.signals.includes('no_prompt_cache_config_detected'));
    const missingUsageReport = buildCacheStatsDiagnostic({
      rows: [
        {
          status: 'succeeded',
          source: 'v2_streaming_reply',
          provider: 'openai_compatible',
          model: 'gpt-5.4-mini',
          top_route_type: 'direct_chat',
          usage: null,
          prompt_caching: null
        }
      ]
    });
    assert.ok(missingUsageReport.latest.signals.includes('missing_usage_input_tokens'));
    assert.ok(missingUsageReport.latest.signals.includes('missing_cache_usage_tokens'));

    assert.strictEqual(report.totals.calls, 3);
    assert.strictEqual(report.totals.breakpoints, 3);
    assert.strictEqual(report.totals.inputTokens, 2300);
    assert.strictEqual(report.totals.cacheReadTokens, 600);
    assert.strictEqual(report.totals.cacheCreationTokens, 320);
    assert.strictEqual(report.totals.cacheReadRatio, 0.2609);
    assert.strictEqual(report.totals.cacheCreationRatio, 0.1391);
    assert.strictEqual(report.totals.cacheActivityRatio, 0.4);
    assert.strictEqual(report.totals.withCacheRead, 1);
    assert.strictEqual(report.totals.withCacheCreation, 2);
    assert.strictEqual(report.totals.withPromptCacheConfig, 2);
    assert.ok(report.signals.counts.anthropic_cache_breakpoints_zero >= 1);
    assert.ok(report.signals.counts.cache_warmup_no_read_tokens >= 1);

    console.log('mainReplyCacheStatsDiagnostics.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})();

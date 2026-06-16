const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}waifu${path.sep}`)) {
      delete require.cache[key];
    }
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
  const envSnapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-model-service-cot-'));
  try {
    Object.assign(process.env, {
      DATA_DIR: tempDir,
      API_KEY: 'test-key',
      API_BASE_URL: 'https://example.com/v1/chat/completions',
      API_PROVIDER: 'openai_compatible',
      AI_MODEL: 'test-model',
      AI_RETRIES: '0',
      AI_FALLBACK_ENABLED: 'false',
      MODEL_TLS_IMPERSONATION_ENABLED: 'false',
      MODEL_TLS_IMPERSONATION_STREAM_ENABLED: 'false'
    });
    clearProjectCache();

    const httpClient = require('../api/httpClient');
    let mockModelResponse = { data: { unexpected: true } };
    httpClient.postWithRetry = async () => mockModelResponse;

    const {
      buildReplyTextVariants,
      finalizeReplyText,
      requestAssistantMessage
    } = require('../api/runtimeV2/model/service');
    const {
      flushModelCallLogsSync,
      startModelCall
    } = require('../utils/modelCallTracker');

    const raw = '答复前<think>内部推理</think>答复后';
    const rawThinking = '答复前<thinking>内部推理</thinking>答复后';
    const variants = buildReplyTextVariants(raw, '', { preserveThink: true });
    assert.strictEqual(variants.visibleText, raw);
    assert.strictEqual(variants.persistedText, '答复前答复后');
    const thinkingVariants = buildReplyTextVariants(rawThinking, '', { preserveThink: true });
    assert.strictEqual(thinkingVariants.visibleText, rawThinking);
    assert.strictEqual(thinkingVariants.persistedText, '答复前答复后');

    const finalized = await finalizeReplyText(raw, '', {
      preserveThink: true,
      disableHumanizer: true
    });
    assert.strictEqual(finalized.visibleText, raw);
    assert.strictEqual(finalized.persistedText, '答复前答复后');
    const finalizedThinking = await finalizeReplyText(rawThinking, '', {
      preserveThink: true,
      disableHumanizer: true
    });
    assert.strictEqual(finalizedThinking.visibleText, rawThinking);
    assert.strictEqual(finalizedThinking.persistedText, '答复前答复后');

    const malformedCallId = startModelCall({
      source: 'unit_test',
      request: { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }
    });
    Object.defineProperty(mockModelResponse, '__modelCallId', {
      value: malformedCallId,
      enumerable: false,
      configurable: true
    });
    const malformed = await requestAssistantMessage([
      { role: 'user', content: 'hello' }
    ], {
      modelConfig: {
        model: 'test-model',
        apiBaseUrl: 'https://example.com/v1/chat/completions',
        apiKey: 'test-key',
        retries: 0
      }
    });
    assert.strictEqual(malformed.role, 'assistant');
    assert.ok(!String(malformed.content).includes('The model response format was malformed'));
    assert.ok(String(malformed.content).includes('模型返回格式不稳定'));
    flushModelCallLogsSync();
    const rows = fs.readFileSync(path.join(tempDir, 'model-calls.ndjson'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const parseFailure = rows.find((row) => row.status === 'parse_failed');
    assert.ok(parseFailure, 'malformed model response should append a parse_failed diagnostic row');
    assert.strictEqual(parseFailure.final_error_code, 'response_parse_empty');
    assert.strictEqual(parseFailure.parse_stage, 'extract_message_content');
    assert.deepStrictEqual(parseFailure.parse_diagnostic.top_level_keys, ['unexpected']);

    mockModelResponse = {
      data: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '   '
            }
          }
        ]
      }
    };
    const emptyAssistantCallId = startModelCall({
      source: 'unit_test',
      request: { model: 'test-model', messages: [{ role: 'user', content: 'hello empty' }] }
    });
    Object.defineProperty(mockModelResponse, '__modelCallId', {
      value: emptyAssistantCallId,
      enumerable: false,
      configurable: true
    });
    const emptyAssistant = await requestAssistantMessage([
      { role: 'user', content: 'hello empty' }
    ], {
      modelConfig: {
        model: 'test-model',
        apiBaseUrl: 'https://example.com/v1/chat/completions',
        apiKey: 'test-key',
        retries: 0
      }
    });
    assert.strictEqual(emptyAssistant.role, 'assistant');
    assert.ok(String(emptyAssistant.content).includes('模型返回格式不稳定'));
    flushModelCallLogsSync();
    const emptyRows = fs.readFileSync(path.join(tempDir, 'model-calls.ndjson'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const emptyFailure = emptyRows.find((row) => row.id === emptyAssistantCallId && row.status === 'parse_failed');
    assert.ok(emptyFailure, 'assistant empty content should append a parse_failed diagnostic row');
    assert.strictEqual(emptyFailure.final_error_code, 'response_parse_empty');

    mockModelResponse = {
      data: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '   ',
              tool_calls: [
                {
                  id: 'call_lookup',
                  type: 'function',
                  function: {
                    name: 'lookup',
                    arguments: '{}'
                  }
                }
              ]
            }
          }
        ]
      }
    };
    const toolCallOnlyCallId = startModelCall({
      source: 'unit_test',
      request: { model: 'test-model', messages: [{ role: 'user', content: 'hello tool' }] }
    });
    Object.defineProperty(mockModelResponse, '__modelCallId', {
      value: toolCallOnlyCallId,
      enumerable: false,
      configurable: true
    });
    const toolCallOnlyAssistant = await requestAssistantMessage([
      { role: 'user', content: 'hello tool' }
    ], {
      modelConfig: {
        model: 'test-model',
        apiBaseUrl: 'https://example.com/v1/chat/completions',
        apiKey: 'test-key',
        retries: 0
      }
    });
    assert.strictEqual(toolCallOnlyAssistant.role, 'assistant');
    assert.strictEqual(toolCallOnlyAssistant.tool_calls[0].function.name, 'lookup');
    flushModelCallLogsSync();
    const toolCallRows = fs.readFileSync(path.join(tempDir, 'model-calls.ndjson'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const toolCallParseFailure = toolCallRows.find((row) => row.id === toolCallOnlyCallId && row.status === 'parse_failed');
    assert.ok(!toolCallParseFailure, 'assistant tool_calls without text should remain usable');

    const oversizedJson = JSON.stringify({ unexpected: 'x'.repeat(110 * 1024) });
    mockModelResponse = { data: oversizedJson, status: 200 };
    const oversizedCallId = startModelCall({
      source: 'unit_test',
      request: { model: 'test-model', messages: [{ role: 'user', content: 'hello large json' }] }
    });
    Object.defineProperty(mockModelResponse, '__modelCallId', {
      value: oversizedCallId,
      enumerable: false,
      configurable: true
    });
    const oversizedMalformed = await requestAssistantMessage([
      { role: 'user', content: 'hello large json' }
    ], {
      modelConfig: {
        model: 'test-model',
        apiBaseUrl: 'https://example.com/v1/chat/completions',
        apiKey: 'test-key',
        retries: 0
      }
    });
    assert.strictEqual(oversizedMalformed.role, 'assistant');
    assert.ok(String(oversizedMalformed.content).includes('模型返回格式不稳定'));
    assert.ok(!String(oversizedMalformed.content).includes('xxxxxxxxxx'));
    flushModelCallLogsSync();
    const nextRows = fs.readFileSync(path.join(tempDir, 'model-calls.ndjson'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const oversizedFailure = nextRows.find((row) => row.parse_diagnostic?.string_json_parse_guard === 'size_limit');
    assert.ok(oversizedFailure, 'oversized malformed JSON should be guarded before JSON.parse');
    assert.strictEqual(oversizedFailure.parse_diagnostic.string_json_parsed, false);
  } finally {
    restoreEnv(envSnapshot);
    clearProjectCache();
  }

  console.log('modelServiceCot.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

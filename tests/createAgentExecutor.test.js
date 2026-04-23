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

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-create-agent-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempRoot;
    process.env.CREATE_AGENT_ENABLED = 'true';
    process.env.CREATE_AGENT_API_BASE_URL = 'https://mynav.website/v1/chat/completions';
    process.env.CREATE_AGENT_API_KEY = 'create-test-key';
    process.env.CREATE_AGENT_MODEL = 'gpt-image-2';
    process.env.CREATE_AGENT_IMAGE_SIZE = '1024x1024';
    process.env.CREATE_AGENT_IMAGE_QUALITY = 'high';
    process.env.CREATE_AGENT_IMAGE_BACKGROUND = 'auto';
    process.env.CREATE_AGENT_RESPONSE_FORMAT = 'b64_json';
    process.env.CREATE_AGENT_OUTPUT_FORMAT = 'png';
    process.env.CREATE_AGENT_DAILY_LIMIT = '2';
    process.env.CREATE_AGENT_OUTPUT_DIR = path.join(tempRoot, 'output');

    clearProjectCache();

    const {
      buildCreateAgentGenerationUrl,
      buildCreateAgentGenerationUrlCandidates,
      detectImageExtension,
      downloadImageFromUrl,
      executeCreateCommand,
      extractImageFromGenerationResponse,
      generateImageWithOpenAICompatibleApi,
      getQuotaStatus,
      isRuntimeStateStale,
      normalizeCreateAgentBaseUrl,
      normalizeRequestError,
      requestImageGeneration,
      writeJsonFileSafe,
      resolveConfig
    } = require('../api/createAgentExecutor');

    assert.strictEqual(normalizeCreateAgentBaseUrl('https://mynav.website/v1/chat/completions'), 'https://mynav.website/v1');
    assert.strictEqual(normalizeCreateAgentBaseUrl('https://tokenflux.dev/v1/images/generations'), 'https://tokenflux.dev/v1');
    assert.strictEqual(buildCreateAgentGenerationUrl('https://mynav.website/v1/chat/completions'), 'https://mynav.website/v1/images/generations');
    assert.deepStrictEqual(
      buildCreateAgentGenerationUrlCandidates('https://www.packyapi.com'),
      ['https://www.packyapi.com/images/generations', 'https://www.packyapi.com/v1/images/generations']
    );

    assert.deepStrictEqual(
      extractImageFromGenerationResponse({ data: [{ b64_json: 'Zm9v' }] }),
      { kind: 'b64_json', value: 'Zm9v' }
    );
    assert.deepStrictEqual(
      extractImageFromGenerationResponse({ data: [{ url: 'https://example.com/test.png' }] }),
      { kind: 'url', value: 'https://example.com/test.png' }
    );
    assert.strictEqual(detectImageExtension(Buffer.from('89504E470D0A1A0A', 'hex')), '.png');

    const runtimeConfig = resolveConfig();
    const pngBase64 = 'iVBORw0KGgo=';
    const sentImages = [];

    const okResult = await executeCreateCommand({
      prompt: 'small orange cat in space',
      chatType: 'group',
      groupId: 'g1',
      senderId: 'u1'
    }, {
      config: runtimeConfig,
      generateImage: async (prompt, receivedConfig) => {
        assert.ok(String(prompt).includes('small orange cat in space'));
        assert.strictEqual(receivedConfig.apiBaseUrl, 'https://mynav.website/v1');
        assert.strictEqual(receivedConfig.model, 'gpt-image-2');
        return {
          filePath: path.join(tempRoot, 'output', 'b64-test.png'),
          buffer: Buffer.from(pngBase64, 'base64')
        };
      },
      sendGroupImageMessage: async (groupId, imageInput) => {
        sentImages.push({ groupId, imageInput });
        return { success: true };
      }
    });

    assert.strictEqual(okResult.ok, true);
    assert.strictEqual(okResult.code, 'sent');
    assert.strictEqual(sentImages.length, 1);
    assert.strictEqual(sentImages[0].groupId, 'g1');
    assert.ok(Buffer.isBuffer(sentImages[0].imageInput));

    let quotaStatus = getQuotaStatus(runtimeConfig);
    assert.strictEqual(quotaStatus.used, 1);
    assert.strictEqual(quotaStatus.remaining, 1);

    const secondResult = await executeCreateCommand({
      prompt: 'misty forest shrine',
      chatType: 'group',
      groupId: 'g2',
      senderId: 'u2'
    }, {
      config: {
        ...runtimeConfig,
        quotaFile: path.join(tempRoot, 'quota-2.json'),
        runtimeFile: path.join(tempRoot, 'runtime-2.json'),
        errorLogFile: path.join(tempRoot, 'errors-2.log')
      },
      generateImage: async () => ({
        filePath: path.join(tempRoot, 'output', 'second-test.png'),
        buffer: Buffer.from(pngBase64, 'base64')
      }),
      sendGroupImageMessage: async () => ({ success: true })
    });
    assert.strictEqual(secondResult.ok, true);

    const requestPayloads = [];
    const requestResponse = await requestImageGeneration('draw a fox', runtimeConfig, {
      httpClient: {
        async post(url, body, options) {
          requestPayloads.push({ url, body, options });
          return {
            data: {
              data: [{ b64_json: pngBase64 }]
            }
          };
        }
      }
    });
    assert.strictEqual(requestPayloads.length, 1);
    assert.strictEqual(requestPayloads[0].url, 'https://mynav.website/v1/images/generations');
    assert.strictEqual(requestPayloads[0].body.model, 'gpt-image-2');
    assert.strictEqual(requestPayloads[0].body.prompt, 'draw a fox');
    assert.strictEqual(requestPayloads[0].body.size, '1024x1024');
    assert.strictEqual(requestPayloads[0].body.quality, 'high');
    assert.strictEqual(requestPayloads[0].body.background, 'auto');
    assert.strictEqual(requestPayloads[0].body.output_format, 'png');
    assert.strictEqual(requestPayloads[0].body.response_format, 'b64_json');
    assert.deepStrictEqual(requestResponse, {
      payload: { data: [{ b64_json: pngBase64 }] },
      requestUrl: 'https://mynav.website/v1/images/generations'
    });

    const fallbackUrls = [];
    const fallbackRequestResponse = await requestImageGeneration('draw a fox again', {
      ...runtimeConfig,
      apiBaseUrl: 'https://www.packyapi.com'
    }, {
      httpClient: {
        async post(url) {
          fallbackUrls.push(url);
          if (url === 'https://www.packyapi.com/images/generations') {
            return { data: { ok: true, message: 'not image payload' } };
          }
          return {
            data: {
              data: [{ b64_json: pngBase64 }]
            }
          };
        }
      }
    });
    assert.deepStrictEqual(fallbackUrls, [
      'https://www.packyapi.com/images/generations',
      'https://www.packyapi.com/v1/images/generations'
    ]);
    assert.deepStrictEqual(fallbackRequestResponse, {
      payload: { data: [{ b64_json: pngBase64 }] },
      requestUrl: 'https://www.packyapi.com/v1/images/generations'
    });

    const generatedFromB64 = await generateImageWithOpenAICompatibleApi('b64 sample', runtimeConfig, {
      httpClient: {
        async post() {
          return { data: { data: [{ b64_json: pngBase64 }] } };
        }
      }
    });
    assert.ok(fs.existsSync(generatedFromB64.filePath));
    assert.ok(Buffer.isBuffer(generatedFromB64.buffer));

    const generatedFromUrl = await generateImageWithOpenAICompatibleApi('url sample', {
      ...runtimeConfig,
      responseFormat: 'url'
    }, {
      httpClient: {
        async post() {
          return { data: { data: [{ url: 'https://example.com/out.png' }] } };
        },
        async get(url, options) {
          assert.strictEqual(url, 'https://example.com/out.png');
          assert.strictEqual(options.responseType, 'arraybuffer');
          return {
            data: Buffer.from(pngBase64, 'base64'),
            headers: { 'content-type': 'image/png' }
          };
        }
      }
    });
    assert.ok(fs.existsSync(generatedFromUrl.filePath));
    assert.ok(Buffer.isBuffer(generatedFromUrl.buffer));

    const downloadedFromDataUrl = await downloadImageFromUrl(
      `data:image/png;base64,${pngBase64}`,
      'data url sample',
      runtimeConfig,
      {}
    );
    assert.ok(fs.existsSync(downloadedFromDataUrl.filePath));

    const overQuotaConfig = {
      ...runtimeConfig,
      quotaFile: path.join(tempRoot, 'quota-limit.json'),
      runtimeFile: path.join(tempRoot, 'runtime-limit.json'),
      errorLogFile: path.join(tempRoot, 'errors-limit.log')
    };
    writeJsonFileSafe(overQuotaConfig.quotaFile, {
      day: runtimeConfig.timezone ? require('../utils/time').todayStrInTz(runtimeConfig.timezone) : '2026-04-22',
      used: 2
    });
    const overQuota = await executeCreateCommand({
      prompt: 'third image should fail',
      chatType: 'group',
      groupId: 'g3',
      senderId: 'u3'
    }, {
      config: overQuotaConfig,
      generateImage: async () => {
        throw new Error('should not run when quota exceeded');
      },
      sendGroupImageMessage: async () => ({ success: true })
    });

    assert.strictEqual(overQuota.ok, false);
    assert.strictEqual(overQuota.code, 'quota_exceeded');
    assert.strictEqual(overQuota.replyText, '今日生图额度已用完');

    const tomorrow = '2099-12-31';
    writeJsonFileSafe(runtimeConfig.quotaFile, { day: tomorrow, used: 99 });
    quotaStatus = getQuotaStatus(runtimeConfig);
    assert.strictEqual(quotaStatus.used, 0);

    writeJsonFileSafe(runtimeConfig.runtimeFile, { running: 1, updatedAt: Date.now() });
    const busy = await executeCreateCommand({
      prompt: 'busy case',
      chatType: 'group',
      groupId: 'g4',
      senderId: 'u4'
    }, {
      config: { ...runtimeConfig, maxConcurrency: 1 },
      generateImage: async () => {
        throw new Error('should not run when busy');
      },
      sendGroupImageMessage: async () => ({ success: true })
    });
    assert.strictEqual(busy.ok, false);
    assert.strictEqual(busy.code, 'busy');
    assert.strictEqual(busy.replyText, '生图 worker 正忙，请稍后重试');

    const staleBusyConfig = {
      ...runtimeConfig,
      runtimeFile: path.join(tempRoot, 'runtime-stale.json'),
      quotaFile: path.join(tempRoot, 'quota-stale.json'),
      errorLogFile: path.join(tempRoot, 'errors-stale.log')
    };
    writeJsonFileSafe(staleBusyConfig.runtimeFile, {
      running: 1,
      updatedAt: Date.now() - (staleBusyConfig.timeoutMs + 120000),
      ownerPid: 999999
    });
    assert.strictEqual(isRuntimeStateStale(staleBusyConfig, {
      running: 1,
      updatedAt: Date.now() - (staleBusyConfig.timeoutMs + 120000),
      ownerPid: 999999
    }), true);
    const staleRecovered = await executeCreateCommand({
      prompt: 'recover stale busy',
      chatType: 'group',
      groupId: 'g4b',
      senderId: 'u4b'
    }, {
      config: staleBusyConfig,
      generateImage: async () => ({
        filePath: path.join(tempRoot, 'output', 'stale-test.png'),
        buffer: Buffer.from(pngBase64, 'base64')
      }),
      sendGroupImageMessage: async () => ({ success: true })
    });
    assert.strictEqual(staleRecovered.ok, true);

    const disabled = await executeCreateCommand({
      prompt: 'disabled case',
      chatType: 'group',
      groupId: 'g5',
      senderId: 'u5'
    }, {
      config: { ...runtimeConfig, enabled: false }
    });
    assert.strictEqual(disabled.ok, false);
    assert.strictEqual(disabled.code, 'disabled');

    const privateOnly = await executeCreateCommand({
      prompt: 'private should reject',
      chatType: 'private',
      groupId: '',
      senderId: 'u6'
    }, {
      config: runtimeConfig
    });
    assert.strictEqual(privateOnly.ok, false);
    assert.strictEqual(privateOnly.code, 'group_only');
    assert.strictEqual(privateOnly.replyText, '仅群聊可用');

    const missingConfig = await executeCreateCommand({
      prompt: 'missing config',
      chatType: 'group',
      groupId: 'g7',
      senderId: 'u7'
    }, {
      config: {
        ...runtimeConfig,
        apiBaseUrl: '',
        quotaFile: path.join(tempRoot, 'quota-missing-base.json'),
        runtimeFile: path.join(tempRoot, 'runtime-missing-base.json'),
        errorLogFile: path.join(tempRoot, 'errors-missing-base.log')
      }
    });
    assert.strictEqual(missingConfig.ok, false);
    assert.strictEqual(missingConfig.replyText, '生图接口未配置');

    const unsupportedModel = await executeCreateCommand({
      prompt: 'unsupported model case',
      chatType: 'group',
      groupId: 'g8',
      senderId: 'u8'
    }, {
      config: {
        ...runtimeConfig,
        quotaFile: path.join(tempRoot, 'quota-unsupported.json'),
        runtimeFile: path.join(tempRoot, 'runtime-unsupported.json'),
        errorLogFile: path.join(tempRoot, 'errors-unsupported.log')
      },
      generateImage: async () => {
        throw new Error('http_error status=502 body={"error":{"message":"unknown provider for model gpt-image-2"}}');
      },
      sendGroupImageMessage: async () => ({ success: true })
    });
    assert.strictEqual(unsupportedModel.ok, false);
    assert.strictEqual(unsupportedModel.replyText, '当前生图供应商不支持 gpt-image-2');

    const authFailure = await executeCreateCommand({
      prompt: 'auth failure',
      chatType: 'group',
      groupId: 'g9',
      senderId: 'u9'
    }, {
      config: {
        ...runtimeConfig,
        quotaFile: path.join(tempRoot, 'quota-auth.json'),
        runtimeFile: path.join(tempRoot, 'runtime-auth.json'),
        errorLogFile: path.join(tempRoot, 'errors-auth.log')
      },
      generateImage: async () => {
        throw new Error('http_error status=401 body={"error":"unauthorized"}');
      }
    });
    assert.strictEqual(authFailure.ok, false);
    assert.strictEqual(authFailure.replyText, '生图鉴权失败');

    const gatewayQuotaFailure = await executeCreateCommand({
      prompt: 'gateway quota failure',
      chatType: 'group',
      groupId: 'g10',
      senderId: 'u10'
    }, {
      config: {
        ...runtimeConfig,
        quotaFile: path.join(tempRoot, 'quota-gateway-quota.json'),
        runtimeFile: path.join(tempRoot, 'runtime-gateway-quota.json'),
        errorLogFile: path.join(tempRoot, 'errors-gateway-quota.log')
      },
      generateImage: async () => {
        throw new Error('http_error status=400 body={"error":{"message":"系统网关次数不足，请联系客服"}}');
      }
    });
    assert.strictEqual(gatewayQuotaFailure.ok, false);
    assert.strictEqual(gatewayQuotaFailure.replyText, '生图供应商额度不足，请联系服务商');

    assert.strictEqual(
      normalizeRequestError({ response: { status: 429, data: { error: 'rate_limited' } } }),
      'http_error status=429 body={"error":"rate_limited"}'
    );

    console.log('createAgentExecutor.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

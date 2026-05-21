const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

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
    process.env.CREATE_AGENT_PROTOCOL = 'images';
    process.env.CREATE_AGENT_IMAGE_SIZE = '1024x1024';
    process.env.CREATE_AGENT_IMAGE_QUALITY = 'high';
    process.env.CREATE_AGENT_IMAGE_BACKGROUND = 'auto';
    process.env.CREATE_AGENT_IMAGE_STYLE = 'vivid';
    process.env.CREATE_AGENT_IMAGE_OUTPUT_COMPRESSION = '0';
    process.env.CREATE_AGENT_RESPONSE_FORMAT = 'b64_json';
    process.env.CREATE_AGENT_OUTPUT_FORMAT = 'png';
    process.env.CREATE_AGENT_DAILY_LIMIT = '2';
    process.env.CREATE_AGENT_OUTPUT_DIR = path.join(tempRoot, 'output');
    process.env.ADMIN_USER_IDS = '1960901788';

    clearProjectCache();
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=';
    const invalidPngBase64 = 'iVBORw0KGgo=';

    const {
      buildCreateAgentAllowedUserIds,
      buildCreateAgentChatCompletionsUrl,
      buildCreateAgentChatCompletionsUrlCandidates,
      buildCreateAgentGenerationUrl,
      buildCreateAgentGenerationUrlCandidates,
      extractImageFromChatCompletionsResponse,
      buildImageGenerationRequestBodyVariants,
      detectImageExtension,
      downloadImageFromUrl,
      executeCreateCommand,
      extractImageFromGenerationResponse,
      extractImageFromStreamEventPayload,
      generateImageWithOpenAICompatibleApi,
      getQuotaStatus,
      loadRuntimeState,
      isCreateAgentUserAllowed,
      isImageGenerationParameterCompatibilityError,
      isRuntimeStateStale,
      normalizeCreateAgentBaseUrl,
      normalizeCreateAgentProtocol,
      normalizeIdList,
      normalizeRequestedImageSize,
      normalizeRequestError,
      postImageGenerationWithCompatibilityFallback,
      requestImageGeneration,
      requestImageGenerationStream,
      writeJsonFileSafe,
      clearRuntimeSlotsForCurrentProcess,
      resolveConfig
    } = require('../api/createAgentExecutor');

    assert.strictEqual(normalizeCreateAgentBaseUrl('https://mynav.website/v1/chat/completions'), 'https://mynav.website/v1');
    assert.strictEqual(normalizeCreateAgentBaseUrl('https://tokenflux.dev/v1/images/generations'), 'https://tokenflux.dev/v1');
    assert.strictEqual(normalizeCreateAgentProtocol('chat'), 'chat_completions');
    assert.strictEqual(normalizeCreateAgentProtocol('chat_completions'), 'chat_completions');
    assert.strictEqual(normalizeCreateAgentProtocol('images'), 'images');
    assert.deepStrictEqual(normalizeIdList(['u1', 'u1', ' ', 'u2']), ['u1', 'u2']);
    assert.strictEqual(buildCreateAgentGenerationUrl('https://mynav.website/v1/chat/completions'), 'https://mynav.website/v1/images/generations');
    assert.strictEqual(buildCreateAgentChatCompletionsUrl('https://mynav.website/v1'), 'https://mynav.website/v1/chat/completions');
    assert.deepStrictEqual(
      buildCreateAgentChatCompletionsUrlCandidates('https://mynav.website'),
      ['https://mynav.website/v1/chat/completions']
    );
    assert.strictEqual(normalizeRequestedImageSize('4096x4096'), '4096x4096');
    assert.strictEqual(normalizeRequestedImageSize('4096x2304'), '4096x2304');
    assert.strictEqual(normalizeRequestedImageSize('2304x4096'), '2304x4096');
    assert.deepStrictEqual(
      Array.from(buildCreateAgentAllowedUserIds({ allowUserIds: ['u_extra', 'u_extra'] })).sort(),
      ['1960901788', 'u_extra']
    );
    assert.strictEqual(isCreateAgentUserAllowed('1960901788'), true);
    assert.strictEqual(isCreateAgentUserAllowed('u_extra', { allowUserIds: ['u_extra'] }), true);
    assert.strictEqual(isCreateAgentUserAllowed('u_other', { allowUserIds: ['u_extra'] }), false);
    assert.strictEqual(
      isImageGenerationParameterCompatibilityError({
        response: {
          status: 400,
          data: {
            error: {
              message: "Unknown parameter: 'tools[0].style'.",
              type: 'invalid_request_error',
              param: 'tools[0].style',
              code: 'unknown_parameter'
            }
          }
        }
      }),
      true
    );
    assert.strictEqual(
      isImageGenerationParameterCompatibilityError({
        response: {
          status: 400,
          data: {
            error: {
              message: 'Compression less than 100 is not supported for PNG output format',
              type: 'image_generation_user_error',
              param: 'tools',
              code: 'invalid_png_output_compression'
            }
          }
        }
      }),
      true
    );
    assert.deepStrictEqual(
      buildCreateAgentGenerationUrlCandidates('https://www.packyapi.com'),
      ['https://www.packyapi.com/images/generations', 'https://www.packyapi.com/v1/images/generations']
    );
    assert.deepStrictEqual(
      buildCreateAgentGenerationUrlCandidates('https://www.right.codes/draw'),
      ['https://www.right.codes/draw/v1/images/generations', 'https://www.right.codes/draw/images/generations']
    );

    assert.deepStrictEqual(
      extractImageFromGenerationResponse({ data: [{ b64_json: 'Zm9v' }] }),
      { kind: 'b64_json', value: 'Zm9v' }
    );
    assert.deepStrictEqual(
      extractImageFromGenerationResponse({ data: [{ url: 'https://example.com/test.png' }] }),
      { kind: 'url', value: 'https://example.com/test.png' }
    );
    assert.deepStrictEqual(
      extractImageFromChatCompletionsResponse({
        choices: [{ message: { content: [{ type: 'output_image', image_url: { url: 'https://example.com/chat-image.png' } }] } }]
      }),
      { kind: 'url', value: 'https://example.com/chat-image.png' }
    );
    assert.deepStrictEqual(
      extractImageFromChatCompletionsResponse({
        choices: [{ message: { content: [{ type: 'output_text', text: `data:image/png;base64,${pngBase64}` }] } }]
      }),
      { kind: 'url', value: `data:image/png;base64,${pngBase64}` }
    );
    assert.deepStrictEqual(
      extractImageFromChatCompletionsResponse({
        choices: [{ message: { content: JSON.stringify({ b64_json: pngBase64 }) } }]
      }),
      { kind: 'b64_json', value: pngBase64 }
    );
    assert.deepStrictEqual(
      extractImageFromChatCompletionsResponse({
        choices: [{
          message: {
            content: [
              { type: 'output_text', text: '{"b64_json":"' },
              { type: 'output_text', text: pngBase64 },
              { type: 'output_text', text: '"}' }
            ]
          }
        }]
      }),
      { kind: 'b64_json', value: pngBase64 }
    );
    assert.deepStrictEqual(
      extractImageFromStreamEventPayload({ type: 'image_generation.completed', b64_json: 'Zm9v' }),
      { kind: 'b64_json', value: 'Zm9v', eventType: 'image_generation.completed' }
    );
    assert.strictEqual(detectImageExtension(Buffer.from('89504E470D0A1A0A', 'hex')), '.png');

    const runtimeConfig = resolveConfig();
    assert.strictEqual(runtimeConfig.requestedImageSize, '1024x1024');
    assert.strictEqual(runtimeConfig.imageSize, '1024x1024');
    assert.strictEqual(runtimeConfig.protocol, 'images');
    assert.deepStrictEqual(runtimeConfig.allowUserIds, []);
    const bodyVariants = buildImageGenerationRequestBodyVariants('draw a fox', runtimeConfig, {});
    assert.ok(bodyVariants.length >= 3);
    assert.strictEqual(bodyVariants[0].style, 'vivid');
    assert.ok(bodyVariants.some((body) => !Object.prototype.hasOwnProperty.call(body, 'style')));
    assert.ok(bodyVariants.some((body) => Object.keys(body).join(',') === 'model,prompt'));
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
        assert.ok(String(prompt).includes('Prioritize crisp focus'));
        assert.ok(String(prompt).includes('Avoid blur, softness, haze'));
        assert.ok(String(prompt).includes('Target clean high-resolution clarity'));
        assert.ok(String(prompt).includes('Preserve facial features, eyes, hands, hair strands'));
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
    assert.strictEqual(requestPayloads[0].body.style, 'vivid');
    assert.strictEqual(requestPayloads[0].body.background, 'auto');
    assert.strictEqual(requestPayloads[0].body.output_format, 'png');
    assert.strictEqual(requestPayloads[0].body.output_compression, 0);
    assert.strictEqual(requestPayloads[0].body.response_format, 'b64_json');
    assert.deepStrictEqual(requestResponse, {
      payload: { data: [{ b64_json: pngBase64 }] },
      requestUrl: 'https://mynav.website/v1/images/generations'
    });

    const compatibilityFallbackBodies = [];
    const compatibilityFallbackResult = await postImageGenerationWithCompatibilityFallback(
      'https://mynav.website/v1/images/generations',
      'draw a fox with fallback',
      runtimeConfig,
      {
        httpClient: {
          async post(url, body) {
            compatibilityFallbackBodies.push(body);
            if (Object.prototype.hasOwnProperty.call(body, 'style')) {
              const error = new Error('bad request');
              error.response = {
                status: 400,
                data: {
                  error: {
                    message: "Unknown parameter: 'tools[0].style'.",
                    type: 'invalid_request_error',
                    param: 'tools[0].style',
                    code: 'unknown_parameter'
                  }
                }
              };
              throw error;
            }
            return {
              data: {
                data: [{ b64_json: pngBase64 }]
              }
            };
          }
        }
      },
      {}
    );
    assert.strictEqual(compatibilityFallbackBodies.length >= 2, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(compatibilityFallbackBodies[0], 'style'), true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(compatibilityFallbackBodies[1], 'style'), false);
    assert.deepStrictEqual(compatibilityFallbackResult.response.data, {
      data: [{ b64_json: pngBase64 }]
    });

    const largeSizeConfig = resolveConfig({ imageSize: '4096x4096' });
    assert.strictEqual(largeSizeConfig.requestedImageSize, '4096x4096');
    assert.strictEqual(largeSizeConfig.imageSize, '4096x4096');
    assert.ok(
      String(require('../api/createAgentExecutor').buildCreateAgentPrompt('sharp portrait', {
        imageSize: '2048x2048'
      })).includes('Target true 2K-class clarity')
    );

    const streamRequestPayloads = [];
    const streamedResponse = await requestImageGenerationStream('stream fox', runtimeConfig, {
      httpClient: {
        async post(url, body, options) {
          streamRequestPayloads.push({ url, body, options });
          const stream = Readable.from([
            'data: {"type":"image_generation.partial_image","partial_image_b64":"Zm9v"}\n\n',
            `data: {"type":"image_generation.completed","b64_json":"${pngBase64}"}\n\n`,
            'data: [DONE]\n\n'
          ]);
          return { data: stream };
        }
      }
    });
    assert.strictEqual(streamRequestPayloads.length, 1);
    assert.strictEqual(streamRequestPayloads[0].body.stream, true);
    assert.strictEqual(streamRequestPayloads[0].body.partial_images, 1);
    assert.strictEqual(streamRequestPayloads[0].options.responseType, 'stream');
    assert.deepStrictEqual(streamedResponse, {
      imageResult: {
        kind: 'b64_json',
        value: pngBase64,
        eventType: 'image_generation.completed'
      },
      requestUrl: 'https://mynav.website/v1/images/generations',
      streamMode: true
    });

    const streamedJsonFallback = await requestImageGenerationStream('buffered fox', runtimeConfig, {
      httpClient: {
        async post() {
          return {
            data: Readable.from([JSON.stringify({ data: [{ b64_json: pngBase64 }] })])
          };
        }
      }
    });
    assert.deepStrictEqual(streamedJsonFallback, {
      imageResult: { kind: 'b64_json', value: pngBase64, eventType: '' },
      requestUrl: 'https://mynav.website/v1/images/generations',
      streamMode: false
    });

    const chatProtocolConfig = resolveConfig({
      protocol: 'chat_completions',
      apiBaseUrl: 'https://superapi.buzz',
      quotaFile: path.join(tempRoot, 'quota-chat.json'),
      runtimeFile: path.join(tempRoot, 'runtime-chat.json'),
      errorLogFile: path.join(tempRoot, 'errors-chat.log')
    });
    assert.strictEqual(chatProtocolConfig.protocol, 'chat_completions');

    const chatRequestPayloads = [];
    const chatRequestResponse = await requestImageGeneration('draw a fox in chat mode', chatProtocolConfig, {
      httpClient: {
        async post(url, body, options) {
          chatRequestPayloads.push({ url, body, options });
          return {
            data: {
              choices: [
                {
                  message: {
                    content: [
                      { type: 'output_image', image_url: { url: 'https://example.com/chat-request.png' } }
                    ]
                  }
                }
              ]
            }
          };
        }
      }
    });
    assert.strictEqual(chatRequestPayloads.length, 1);
    assert.strictEqual(chatRequestPayloads[0].url, 'https://superapi.buzz/v1/chat/completions');
    assert.strictEqual(chatRequestPayloads[0].body.model, 'gpt-image-2');
    assert.strictEqual(chatRequestPayloads[0].body.stream, false);
    assert.ok(String(chatRequestPayloads[0].body.messages[0].content).includes('draw a fox in chat mode'));
    assert.deepStrictEqual(chatRequestResponse, {
      payload: {
        choices: [
          {
            message: {
              content: [
                { type: 'output_image', image_url: { url: 'https://example.com/chat-request.png' } }
              ]
            }
          }
        ]
      },
      requestUrl: 'https://superapi.buzz/v1/chat/completions'
    });

    const chatStreamPayloads = [];
    const chatStreamResponse = await requestImageGenerationStream('stream chat fox', chatProtocolConfig, {
      httpClient: {
        async post(url, body, options) {
          chatStreamPayloads.push({ url, body, options });
          const stream = Readable.from([
            `data: {"choices":[{"delta":{"content":[{"type":"output_text","text":"https://example.com/stream-chat.png"}]}}]}\n\n`,
            'data: [DONE]\n\n'
          ]);
          return { data: stream };
        }
      }
    });
    assert.strictEqual(chatStreamPayloads.length, 1);
    assert.strictEqual(chatStreamPayloads[0].url, 'https://superapi.buzz/v1/chat/completions');
    assert.strictEqual(chatStreamPayloads[0].body.stream, true);
    assert.deepStrictEqual(chatStreamResponse, {
      imageResult: {
        kind: 'url',
        value: 'https://example.com/stream-chat.png',
        eventType: ''
      },
      requestUrl: 'https://superapi.buzz/v1/chat/completions',
      streamMode: true
    });

    const chatJsonStringResponse = await requestImageGeneration('chat string json mode', chatProtocolConfig, {
      httpClient: {
        async post() {
          return {
            data: {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ b64_json: pngBase64 })
                  }
                }
              ]
            }
          };
        }
      }
    });
    assert.deepStrictEqual(chatJsonStringResponse, {
      payload: {
        choices: [
          {
            message: {
              content: JSON.stringify({ b64_json: pngBase64 })
            }
          }
        ]
      },
      requestUrl: 'https://superapi.buzz/v1/chat/completions'
    });

    const chatGeneratedFromUrl = await generateImageWithOpenAICompatibleApi('chat image sample', {
      ...chatProtocolConfig,
      responseFormat: 'url'
    }, {
      httpClient: {
        async post(url, body, options) {
          if (options?.responseType === 'stream') {
            return {
              data: Readable.from([
                `data: {"choices":[{"delta":{"content":[{"type":"output_text","text":"https://example.com/chat-final.png"}]}}]}\n\n`,
                'data: [DONE]\n\n'
              ])
            };
          }
          return {
            data: {
              choices: [
                {
                  message: {
                    content: [
                      { type: 'output_image', image_url: { url: 'https://example.com/chat-final.png' } }
                    ]
                  }
                }
              ]
            }
          };
        },
        async get(url, options) {
          assert.strictEqual(url, 'https://example.com/chat-final.png');
          assert.strictEqual(options.responseType, 'arraybuffer');
          return {
            data: Buffer.from(pngBase64, 'base64'),
            headers: { 'content-type': 'image/png' }
          };
        }
      }
    });
    assert.ok(fs.existsSync(chatGeneratedFromUrl.filePath));
    assert.ok(Buffer.isBuffer(chatGeneratedFromUrl.buffer));

    const fallbackBodies = [];
    const chatGeneratedFromCorruptB64Fallback = await generateImageWithOpenAICompatibleApi('chat fallback sample', {
      ...chatProtocolConfig,
      responseFormat: 'b64_json'
    }, {
      httpClient: {
        async post(url, body, options) {
          fallbackBodies.push({ url, body, options });
          if (options?.responseType === 'stream') {
            return {
              data: Readable.from([
                `data: {"choices":[{"delta":{"content":[{"type":"output_text","text":"{\\"b64_json\\":\\"${invalidPngBase64}\\"}"}]}}]}\n\n`,
                'data: [DONE]\n\n'
              ])
            };
          }

          if (String(body?.messages?.[0]?.content || '').includes('Return only a direct image URL')) {
            return {
              data: {
                choices: [
                  {
                    message: {
                      content: [
                        { type: 'output_text', text: 'https://example.com/fallback-image.png' }
                      ]
                    }
                  }
                ]
              }
            };
          }

          return {
            data: {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ b64_json: invalidPngBase64 })
                  }
                }
              ]
            }
          };
        },
        async get(url) {
          assert.strictEqual(url, 'https://example.com/fallback-image.png');
          return {
            data: Buffer.from(pngBase64, 'base64'),
            headers: { 'content-type': 'image/png' }
          };
        }
      }
    });
    assert.ok(fs.existsSync(chatGeneratedFromCorruptB64Fallback.filePath));
    assert.ok(Buffer.isBuffer(chatGeneratedFromCorruptB64Fallback.buffer));
    assert.strictEqual(
      fallbackBodies.some((item) => String(item?.body?.messages?.[0]?.content || '').includes('Return only a direct image URL')),
      true
    );

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
        async post(url, body, options) {
          if (options?.responseType === 'stream') {
            throw new Error('stream unsupported');
          }
          return { data: { data: [{ b64_json: pngBase64 }] } };
        }
      }
    });
    assert.ok(fs.existsSync(generatedFromB64.filePath));
    assert.ok(Buffer.isBuffer(generatedFromB64.buffer));

    const generatedWithCompatibilityFallback = await generateImageWithOpenAICompatibleApi('compat fallback sample', runtimeConfig, {
      httpClient: {
        async post(url, body, options) {
          if (options?.responseType === 'stream') {
            throw new Error('stream unsupported');
          }
          if (Object.prototype.hasOwnProperty.call(body, 'style')) {
            const error = new Error('bad request');
            error.response = {
              status: 400,
              data: {
                error: {
                  message: "Unknown parameter: 'tools[0].style'.",
                  type: 'invalid_request_error',
                  param: 'tools[0].style',
                  code: 'unknown_parameter'
                }
              }
            };
            throw error;
          }
          return { data: { data: [{ b64_json: pngBase64 }] } };
        }
      }
    });
    assert.ok(fs.existsSync(generatedWithCompatibilityFallback.filePath));
    assert.ok(Buffer.isBuffer(generatedWithCompatibilityFallback.buffer));

    const generatedFromUrl = await generateImageWithOpenAICompatibleApi('url sample', {
      ...runtimeConfig,
      responseFormat: 'url'
    }, {
      httpClient: {
        async post(url, body, options) {
          if (options?.responseType === 'stream') {
            return {
              data: Readable.from([
                'data: {"type":"image_generation.completed","url":"https://example.com/out.png"}\n\n',
                'data: [DONE]\n\n'
              ])
            };
          }
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

    await assert.rejects(
      () => downloadImageFromUrl('https://example.com/expired.png', 'expired url sample', runtimeConfig, {
        httpClient: {
          async get() {
            const error = new Error('not found');
            error.response = {
              status: 404,
              data: Buffer.from('file not found, The resource is valid for 2 hours', 'utf8')
            };
            throw error;
          }
        }
      }),
      (error) => {
        assert.strictEqual(error.requestUrl, 'https://example.com/expired.png');
        assert.strictEqual(error.message, 'http_error status=404 body=file not found, The resource is valid for 2 hours');
        return true;
      }
    );

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

    const ownedRuntimeFile = path.join(tempRoot, 'runtime-owned.json');
    const ownedRuntimeConfig = {
      ...runtimeConfig,
      runtimeFile: ownedRuntimeFile
    };
    writeJsonFileSafe(ownedRuntimeFile, {
      running: 1,
      updatedAt: Date.now(),
      ownerPid: process.pid
    });
    const clearedOwned = clearRuntimeSlotsForCurrentProcess(ownedRuntimeConfig);
    assert.strictEqual(clearedOwned.cleared, true);
    assert.strictEqual(loadRuntimeState(ownedRuntimeFile).running, 0);

    const foreignRuntimeFile = path.join(tempRoot, 'runtime-foreign.json');
    const foreignRuntimeConfig = {
      ...runtimeConfig,
      runtimeFile: foreignRuntimeFile
    };
    writeJsonFileSafe(foreignRuntimeFile, {
      running: 1,
      updatedAt: Date.now(),
      ownerPid: process.pid + 9999
    });
    const clearedForeign = clearRuntimeSlotsForCurrentProcess(foreignRuntimeConfig);
    assert.strictEqual(clearedForeign.cleared, false);
    assert.strictEqual(loadRuntimeState(foreignRuntimeFile).running, 1);

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

    const corruptImageFailure = await executeCreateCommand({
      prompt: 'corrupt image failure',
      chatType: 'group',
      groupId: 'g9b',
      senderId: 'u9b'
    }, {
      config: {
        ...runtimeConfig,
        quotaFile: path.join(tempRoot, 'quota-corrupt.json'),
        runtimeFile: path.join(tempRoot, 'runtime-corrupt.json'),
        errorLogFile: path.join(tempRoot, 'errors-corrupt.log')
      },
      generateImage: async () => {
        throw new Error('image buffer invalid or truncated format=png reason=png missing IEND');
      }
    });
    assert.strictEqual(corruptImageFailure.ok, false);
    assert.strictEqual(corruptImageFailure.replyText, '生图结果损坏，供应商返回了不完整图片');

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

    const upstreamTimeoutFailure = await executeCreateCommand({
      prompt: 'upstream timeout failure',
      chatType: 'group',
      groupId: 'g11',
      senderId: 'u11'
    }, {
      config: {
        ...runtimeConfig,
        quotaFile: path.join(tempRoot, 'quota-upstream-timeout.json'),
        runtimeFile: path.join(tempRoot, 'runtime-upstream-timeout.json'),
        errorLogFile: path.join(tempRoot, 'errors-upstream-timeout.log')
      },
      generateImage: async () => {
        throw new Error('http_error status=524 body={"title":"Error 524: A timeout occurred","error_name":"origin_response_timeout","cloudflare_error":true}');
      }
    });
    assert.strictEqual(upstreamTimeoutFailure.ok, false);
    assert.strictEqual(upstreamTimeoutFailure.replyText, '生图上游超时，请稍后重试或更换供应商');

    const expiredResourceFailure = await executeCreateCommand({
      prompt: 'expired resource failure',
      chatType: 'group',
      groupId: 'g12',
      senderId: 'u12'
    }, {
      config: {
        ...runtimeConfig,
        quotaFile: path.join(tempRoot, 'quota-expired-resource.json'),
        runtimeFile: path.join(tempRoot, 'runtime-expired-resource.json'),
        errorLogFile: path.join(tempRoot, 'errors-expired-resource.log')
      },
      generateImage: async () => {
        throw new Error('http_error status=404 body=file not found, The resource is valid for 2 hours');
      }
    });
    assert.strictEqual(expiredResourceFailure.ok, false);
    assert.strictEqual(expiredResourceFailure.replyText, '生图临时资源已失效，请重试或更换提示词');

    assert.strictEqual(
      normalizeRequestError({ response: { status: 429, data: { error: 'rate_limited' } } }),
      'http_error status=429 body={"error":"rate_limited"}'
    );
    assert.strictEqual(
      normalizeRequestError({
        response: {
          status: 404,
          data: Buffer.from('file not found, The resource is valid for 2 hours', 'utf8')
        }
      }),
      'http_error status=404 body=file not found, The resource is valid for 2 hours'
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

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-image-visual-summary-'));
process.env.DATA_DIR = tempRoot;
process.env.IMAGE_MEMORY_INDEX_FILE = path.join(tempRoot, 'image_memory_index.json');
process.env.IMAGE_MEMORY_RECALL_ENABLED = 'true';
process.env.IMAGE_MEMORY_VISUAL_SUMMARY_ENABLED = 'true';
process.env.IMAGE_MEMORY_VISUAL_SUMMARY_RETRIES = '0';
process.env.MEMORY_SCOPE_INDEX_FILE = path.join(tempRoot, 'memory_scope_index.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_API_BASE_URL = 'https://memory.example/v1';
process.env.MEMORY_API_KEY = 'memory-key';
process.env.MEMORY_MODEL = 'memory-vision-model';
process.env.ENABLE_DEBUG_LOG = 'false';
process.env.TIMEZONE = 'Asia/Shanghai';

const cacheDir = path.join(tempRoot, 'inbound_image_cache');
fs.mkdirSync(cacheDir, { recursive: true });
const tinyJpegBase64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/AgP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/ISP/2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z';

function writeCachedImage(cacheKey, sourceUrl) {
  const buffer = Buffer.from(tinyJpegBase64, 'base64');
  fs.writeFileSync(path.join(cacheDir, `${cacheKey}.bin`), buffer);
  fs.writeFileSync(path.join(cacheDir, `${cacheKey}.json`), JSON.stringify({
    cacheKey,
    sourceUrl,
    mediaType: 'image/png',
    byteLength: buffer.length,
    createdAt: new Date().toISOString()
  }, null, 2));
}

writeCachedImage('score_img', 'https://example.com/score.png');
writeCachedImage('text_model_img', 'https://example.com/text-model.png');
writeCachedImage('failure_img', 'https://example.com/failure.png');
writeCachedImage('raw_provider_img', 'https://example.com/raw-provider.png');
fs.writeFileSync(process.env.MEMORY_SCOPE_INDEX_FILE, JSON.stringify({ version: 1, users: {} }, null, 2));

const config = require('../config');
const { loadImageMemoryIndex } = require('../utils/imageMemoryIndex');
const { loadMemoryEvents } = require('../utils/memory-v3/events');
const { loadMemoryNodes } = require('../utils/memory-v3/storage');
const { prepareRequest } = require('../api/httpClient');
const {
  buildShortTimestamp,
  normalizeVisualSummaryImagePayload,
  summarizeImageIntoLongTermMemory
} = require('../utils/imageVisualSummaryMemory');

module.exports = (async () => {
  const sharp = require('sharp');
  const tallJpeg = await sharp({
    create: {
      width: 1200,
      height: 2600,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  }).jpeg({ quality: 95 }).toBuffer();
  const normalizedTallImage = await normalizeVisualSummaryImagePayload({
    mediaType: 'image/jpeg',
    byteLength: tallJpeg.length,
    data: tallJpeg.toString('base64')
  });
  const normalizedTallMetadata = await sharp(Buffer.from(normalizedTallImage.data, 'base64')).metadata();
  assert.strictEqual(normalizedTallImage.mediaType, 'image/jpeg');
  assert.ok(normalizedTallMetadata.width <= 1024);
  assert.ok(normalizedTallMetadata.height <= 1024);

  const calls = [];
  const result = await summarizeImageIntoLongTermMemory('cached-image://score_img', {
    userId: 'u_img',
    groupId: 'g_img',
    sessionKey: 'qq-group:g_img:user:u_img',
    messageId: 'm_score',
    imageSource: 'current',
    userText: '今天的战绩图',
    now: new Date('2026-05-20T01:23:00+08:00'),
    force: true
  }, {
    postWithRetry: async (url, body, retries, apiKey) => {
      calls.push({ url, body, retries, apiKey });
      return {
        data: {
          choices: [{
            message: {
              content: '游戏战绩结算截图，画面显示分数 987654、评级 S，并有通关结果信息。'
            }
          }]
        }
      };
    }
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.startsWith('[2026-05-20 01:23]'), true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://memory.example/v1/chat/completions');
  assert.strictEqual(calls[0].apiKey, 'memory-key');
  assert.strictEqual(calls[0].body.model, 'memory-vision-model');
  assert.strictEqual(calls[0].body.__preferredProtocol, 'chat_completions');
  const imagePart = calls[0].body.messages[0].content.find((part) => part.type === 'image_url');
  assert.ok(imagePart, 'visual summary should use OpenAI-compatible image_url parts');
  assert.ok(/^data:image\/jpeg;base64,/i.test(String(imagePart.image_url?.url || '')));
  assert.strictEqual(imagePart.image_url.detail, 'low');
  assert.ok(JSON.stringify(calls[0].body.messages).includes('战绩'));
  const prepared = await prepareRequest(calls[0].url, calls[0].body);
  assert.strictEqual(prepared.requestUrl, 'https://memory.example/v1/chat/completions');
  const preparedImagePart = prepared.requestBody.messages[0].content.find((part) => part.type === 'image_url');
  assert.ok(/^data:image\/jpeg;base64,/i.test(String(preparedImagePart?.image_url?.url || '')));

  const imageIndex = loadImageMemoryIndex();
  assert.ok(imageIndex.images.score_img.summary.includes('战绩结算截图'));
  assert.ok(imageIndex.images.score_img.summary.includes('[2026-05-20 01:23]'));

  const rawProviderResult = await summarizeImageIntoLongTermMemory('cached-image://raw_provider_img', {
    userId: 'u_img',
    now: new Date('2026-06-04T13:40:00+08:00'),
    force: true
  }, {
    postWithRetry: async () => ({
      data: JSON.stringify({
        id: 'chatcmpl-raw-provider',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: '这里是模型推理，不应进入图片记忆。'
          }
        }]
      })
    })
  });
  assert.strictEqual(rawProviderResult.ok, false);
  assert.strictEqual(rawProviderResult.reason, 'empty_summary');
  assert.strictEqual(loadImageMemoryIndex().images.raw_provider_img.summary || '', '');

  const events = loadMemoryEvents();
  assert.ok(events.some((event) => (
    event.type === 'memory_confirmed'
    && event.memoryKind === 'image'
    && event.semanticSlot === 'image_visual_summary'
    && event.canonicalKey === 'image:score_img'
    && event.text.includes('987654')
  )));

  const nodes = loadMemoryNodes();
  assert.ok(nodes.some((node) => (
    node.memoryKind === 'image'
    && node.semanticSlot === 'image_visual_summary'
    && node.text.includes('评级 S')
  )));

  const skipped = await summarizeImageIntoLongTermMemory('cached-image://score_img', {
    userId: 'u_img'
  }, {
    postWithRetry: async () => {
      throw new Error('should not call model when summary exists');
    }
  });
  assert.strictEqual(skipped.ok, true);
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(skipped.reason, 'summary_exists');
  assert.strictEqual(buildShortTimestamp(new Date('2026-05-20T01:23:00+08:00')), '2026-05-20 01:23');

  const originalMemoryModel = config.MEMORY_MODEL;
  const originalSummaryModel = config.IMAGE_MEMORY_VISUAL_SUMMARY_MODEL;
  try {
    config.MEMORY_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
    config.IMAGE_MEMORY_VISUAL_SUMMARY_MODEL = '';
    const textOnlySkipped = await summarizeImageIntoLongTermMemory('cached-image://text_model_img', {
      userId: 'u_img',
      now: new Date('2026-05-20T01:24:00+08:00')
    }, {
      postWithRetry: async () => {
        throw new Error('should not call model for known text-only visual summary model');
      }
    });
    assert.strictEqual(textOnlySkipped.ok, false);
    assert.strictEqual(textOnlySkipped.skipped, true);
    assert.strictEqual(textOnlySkipped.reason, 'visual_model_not_vision_capable');
    assert.strictEqual(loadImageMemoryIndex().images.text_model_img.visualSummaryState.reason, 'visual_model_not_vision_capable');
  } finally {
    config.MEMORY_MODEL = originalMemoryModel;
    config.IMAGE_MEMORY_VISUAL_SUMMARY_MODEL = originalSummaryModel;
  }

  let failureCalls = 0;
  const firstFailure = await summarizeImageIntoLongTermMemory('cached-image://failure_img', {
    userId: 'u_img',
    now: new Date('2026-05-20T01:25:00+08:00')
  }, {
    postWithRetry: async () => {
      failureCalls += 1;
      const error = new Error('Request failed with status code 400');
      error.response = { status: 400 };
      throw error;
    }
  });
  assert.strictEqual(firstFailure.ok, false);
  assert.strictEqual(firstFailure.skipped, false);
  assert.strictEqual(firstFailure.reason, 'http_400');
  assert.strictEqual(failureCalls, 1);
  const failureState = loadImageMemoryIndex().images.failure_img.visualSummaryState;
  assert.strictEqual(failureState.reason, 'http_400');
  assert.strictEqual(failureState.requestShape, 'chat_completions_image_url_data_url');
  assert.ok(Number(failureState.nextRetryAt) > Date.parse('2026-05-20T01:25:00+08:00'));

  const cooledFailure = await summarizeImageIntoLongTermMemory('cached-image://failure_img', {
    userId: 'u_img',
    now: new Date('2026-05-20T01:26:00+08:00')
  }, {
    postWithRetry: async () => {
      failureCalls += 1;
      throw new Error('should not call model while image visual summary is cooling down');
    }
  });
  assert.strictEqual(cooledFailure.ok, false);
  assert.strictEqual(cooledFailure.skipped, true);
  assert.strictEqual(cooledFailure.reason, 'visual_summary_cooldown');
  assert.strictEqual(failureCalls, 1);

  console.log('imageVisualSummaryMemory.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

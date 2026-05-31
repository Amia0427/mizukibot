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
process.env.TIMEZONE = 'Asia/Shanghai';

const cacheDir = path.join(tempRoot, 'inbound_image_cache');
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(
  path.join(cacheDir, 'score_img.bin'),
  Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/AgP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/ISP/2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z', 'base64')
);
fs.writeFileSync(path.join(cacheDir, 'score_img.json'), JSON.stringify({
  cacheKey: 'score_img',
  sourceUrl: 'https://example.com/score.png',
  mediaType: 'image/png',
  byteLength: 10,
  createdAt: new Date().toISOString()
}, null, 2));
fs.writeFileSync(process.env.MEMORY_SCOPE_INDEX_FILE, JSON.stringify({ version: 1, users: {} }, null, 2));

const { loadImageMemoryIndex } = require('../utils/imageMemoryIndex');
const { loadMemoryEvents } = require('../utils/memory-v3/events');
const { loadMemoryNodes } = require('../utils/memory-v3/storage');
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
  assert.ok(JSON.stringify(calls[0].body.messages).includes('"type":"input_image"'));
  assert.ok(JSON.stringify(calls[0].body.messages).includes('战绩'));

  const imageIndex = loadImageMemoryIndex();
  assert.ok(imageIndex.images.score_img.summary.includes('战绩结算截图'));
  assert.ok(imageIndex.images.score_img.summary.includes('[2026-05-20 01:23]'));

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

  console.log('imageVisualSummaryMemory.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

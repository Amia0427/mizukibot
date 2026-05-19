const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-cli-image-'));
process.env.DATA_DIR = tempRoot;
process.env.IMAGE_MEMORY_INDEX_FILE = path.join(tempRoot, 'image_memory_index.json');
process.env.IMAGE_MEMORY_RECALL_ENABLED = 'true';
process.env.MEMORY_SCOPE_INDEX_FILE = path.join(tempRoot, 'memory_scope_index.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_CLI_SEARCH_ENGINE = 'fast';
process.env.MEMORY_CLI_PRELOAD = 'false';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';

fs.mkdirSync(path.join(tempRoot, 'inbound_image_cache'), { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'inbound_image_cache', 'cat_img.bin'), Buffer.from('fake-cat'));
fs.writeFileSync(process.env.MEMORY_SCOPE_INDEX_FILE, JSON.stringify({
  version: 1,
  users: {
    u_group_reader: {
      updatedAt: Date.now(),
      groups: [{ groupId: 'g_img', lastSeenAt: Date.now() }],
      channels: []
    }
  }
}, null, 2), 'utf8');

const { runMemoryCli } = require('../utils/memoryCli');
const { upsertImageMemory } = require('../utils/imageMemoryIndex');

upsertImageMemory({
  cacheKey: 'cat_img',
  imageRef: 'cached-image://cat_img',
  mediaType: 'image/png',
  userId: 'u_img',
  userText: '看看猫猫',
  summary: '一张橘猫趴在桌子上的图片',
  ocrText: 'cat cafe',
  messageId: 'm_cat'
});
upsertImageMemory({
  cacheKey: 'group_img',
  imageRef: 'cached-image://group_img',
  mediaType: 'image/png',
  userId: 'u_sender',
  groupId: 'g_img',
  summary: '群里的服务器部署截图',
  messageId: 'm_group'
});
const scoreImageTime = Date.parse('2026-05-19T16:57:02+08:00');
upsertImageMemory({
  cacheKey: 'score_blank_img',
  imageRef: 'cached-image://score_blank_img',
  mediaType: 'image/png',
  userId: 'u_img',
  groupId: 'g_img',
  userText: '[图片] 宝',
  messageId: 'm_score',
  observedAt: scoreImageTime,
  createdAt: scoreImageTime,
  lastSeenAt: scoreImageTime
});

module.exports = (async () => {
  const search = await runMemoryCli('mem search --source image --query "橘猫"', {
    userId: 'u_img'
  });
  assert.strictEqual(search.ok, true);
  assert.strictEqual(search.results[0].source, 'image');
  assert.strictEqual(search.results[0].ref, 'mc_ref:image:cat_img');

  const opened = await runMemoryCli('mem open --ref "mc_ref:image:cat_img"', {
    userId: 'u_img'
  });
  assert.strictEqual(opened.ok, true);
  assert.strictEqual(opened.source, 'image');
  assert.strictEqual(opened.data.imageRef, 'cached-image://cat_img');
  assert.strictEqual(opened.data.exists, true);

  const blockedPrivate = await runMemoryCli('mem open --ref "mc_ref:image:cat_img"', {
    userId: 'u_other'
  });
  assert.strictEqual(blockedPrivate.ok, false);

  const groupSearch = await runMemoryCli('mem search --source image --query "部署截图"', {
    userId: 'u_group_reader'
  });
  assert.strictEqual(groupSearch.ok, true);
  assert.strictEqual(groupSearch.results[0].id, 'group_img');

  const blockedGroupSearch = await runMemoryCli('mem search --source image --query "部署截图"', {
    userId: 'u_blocked'
  });
  assert.strictEqual(blockedGroupSearch.ok, true);
  assert.strictEqual(blockedGroupSearch.results.length, 0);

  const implicitImageSearch = await runMemoryCli('mem search --query "今天发给你什么战绩图了" --limit 5', {
    userId: 'u_img',
    groupId: 'g_img',
    now: '2026-05-20T00:16:00+08:00'
  });
  assert.strictEqual(implicitImageSearch.ok, true);
  assert.ok(implicitImageSearch.results.some((item) => item.source === 'image' && item.id === 'score_blank_img'));
  assert.ok(implicitImageSearch.sourceCoverage.image >= 1);

  console.log('memoryCliImageRecall.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-cli-image-'));
process.env.DATA_DIR = tempRoot;
process.env.IMAGE_MEMORY_INDEX_FILE = path.join(tempRoot, 'image_memory_index.json');
process.env.IMAGE_MEMORY_RECALL_ENABLED = 'true';
process.env.MEMORY_SCOPE_INDEX_FILE = path.join(tempRoot, 'memory_scope_index.json');

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

  console.log('memoryCliImageRecall.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

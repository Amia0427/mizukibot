const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-image-memory-'));
process.env.DATA_DIR = tempRoot;
process.env.IMAGE_MEMORY_INDEX_FILE = path.join(tempRoot, 'image_memory_index.json');
process.env.IMAGE_MEMORY_RECALL_ENABLED = 'true';
process.env.IMAGE_MEMORY_OBSERVATION_LIMIT = '2';
process.env.MEMORY_SCOPE_INDEX_FILE = path.join(tempRoot, 'memory_scope_index.json');

fs.mkdirSync(path.join(tempRoot, 'inbound_image_cache'), { recursive: true });
fs.writeFileSync(process.env.MEMORY_SCOPE_INDEX_FILE, JSON.stringify({
  version: 1,
  users: {
    u_allowed: {
      updatedAt: Date.now(),
      groups: [{ groupId: 'g_allowed', lastSeenAt: Date.now() }],
      channels: []
    }
  }
}, null, 2), 'utf8');

const {
  loadImageMemoryIndex,
  openImageMemory,
  searchImageMemories,
  upsertImageMemory
} = require('../utils/imageMemoryIndex');

upsertImageMemory({
  cacheKey: 'img_a',
  imageRef: 'cached-image://img_a',
  mediaType: 'image/png',
  sourceUrl: 'https://example.com/cat.png',
  userId: 'u_owner',
  userText: '帮我看看这只猫',
  summary: '一张猫图',
  ocrText: 'cat label',
  messageId: 'm1',
  observedAt: 100
});
upsertImageMemory({
  cacheKey: 'img_a',
  userId: 'u_owner',
  userText: '第二次提到猫图',
  summary: '猫趴在桌子上',
  messageId: 'm2',
  observedAt: 200
});
upsertImageMemory({
  cacheKey: 'img_a',
  userId: 'u_owner',
  userText: '第三次提到猫图',
  messageId: 'm3',
  observedAt: 300
});

const index = loadImageMemoryIndex();
assert.strictEqual(Object.keys(index.images).length, 1);
assert.strictEqual(index.images.img_a.observations.length, 2);

const privateHits = searchImageMemories('猫', { userId: 'u_owner' });
assert.strictEqual(privateHits.length, 1);
assert.strictEqual(privateHits[0].cacheKey, 'img_a');

assert.strictEqual(openImageMemory('mc_ref:image:img_a', { userId: 'u_other' }), null);
const openedMissing = openImageMemory('mc_ref:image:img_a', { userId: 'u_owner' });
assert.strictEqual(openedMissing.imageRef, 'cached-image://img_a');
assert.strictEqual(openedMissing.exists, false);

fs.writeFileSync(path.join(tempRoot, 'inbound_image_cache', 'img_a.bin'), Buffer.from('fake-image'));
assert.strictEqual(openImageMemory('mc_ref:image:img_a', { userId: 'u_owner' }).exists, true);

upsertImageMemory({
  cacheKey: 'img_group',
  imageRef: 'cached-image://img_group',
  userId: 'u_sender',
  groupId: 'g_allowed',
  summary: '群里的部署截图',
  messageId: 'gm1'
});
assert.strictEqual(searchImageMemories('部署截图', { userId: 'u_allowed' }).length, 1);
assert.strictEqual(searchImageMemories('部署截图', { userId: 'u_blocked' }).length, 0);

upsertImageMemory({
  cacheKey: 'img_shared',
  imageRef: 'cached-image://img_shared',
  userId: 'u_owner',
  userText: '只有本人知道的私聊暗号',
  messageId: 'pm_shared'
});
upsertImageMemory({
  cacheKey: 'img_shared',
  imageRef: 'cached-image://img_shared',
  userId: 'u_sender',
  groupId: 'g_allowed',
  userText: '群里可见的公开说明',
  messageId: 'gm_shared'
});
assert.strictEqual(searchImageMemories('私聊暗号', { userId: 'u_allowed' }).length, 0);
assert.strictEqual(searchImageMemories('公开说明', { userId: 'u_allowed' }).length, 1);
assert.strictEqual(searchImageMemories('私聊暗号', { userId: 'u_owner' }).length, 1);

const rawProviderSummary = JSON.stringify({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  choices: [{
    message: {
      role: 'assistant',
      content: '',
      reasoning_content: '这里是模型推理，不应进入图片记忆。'
    }
  }]
});
upsertImageMemory({
  cacheKey: 'img_raw_provider_summary',
  imageRef: 'cached-image://img_raw_provider_summary',
  userId: 'u_owner',
  summary: `[2026-06-04 13:40] ${rawProviderSummary}`,
  messageId: 'raw_provider_summary_1'
});
const rawProviderRecord = loadImageMemoryIndex().images.img_raw_provider_summary;
assert.strictEqual(rawProviderRecord.summary || '', '');
assert.strictEqual(rawProviderRecord.observations[0].summary || '', '');
assert.strictEqual(searchImageMemories('reasoning_content', { userId: 'u_owner' }).length, 0);

const scoreImageTime = Date.parse('2026-05-19T16:57:02+08:00');
upsertImageMemory({
  cacheKey: 'img_score_blank',
  imageRef: 'cached-image://img_score_blank',
  userId: 'u_owner',
  groupId: 'g_allowed',
  userText: '[图片] 宝',
  messageId: 'score1',
  observedAt: scoreImageTime,
  createdAt: scoreImageTime,
  lastSeenAt: scoreImageTime
});
upsertImageMemory({
  cacheKey: 'img_score_old',
  imageRef: 'cached-image://img_score_old',
  userId: 'u_owner',
  groupId: 'g_allowed',
  userText: '[图片] 宝',
  messageId: 'score_old',
  observedAt: Date.parse('2026-05-18T16:57:02+08:00'),
  createdAt: Date.parse('2026-05-18T16:57:02+08:00'),
  lastSeenAt: Date.parse('2026-05-18T16:57:02+08:00')
});
upsertImageMemory({
  cacheKey: 'img_score_future',
  imageRef: 'cached-image://img_score_future',
  userId: 'u_owner',
  groupId: 'g_allowed',
  userText: '[图片] 事后讨论',
  messageId: 'score_future',
  observedAt: Date.parse('2026-05-20T00:30:00+08:00'),
  createdAt: Date.parse('2026-05-20T00:30:00+08:00'),
  lastSeenAt: Date.parse('2026-05-20T00:30:00+08:00')
});
const scoreHits = searchImageMemories('今天发给你什么战绩图了', {
  userId: 'u_owner',
  groupId: 'g_allowed',
  now: '2026-05-20T00:16:00+08:00'
});
assert.strictEqual(scoreHits[0].cacheKey, 'img_score_blank');
assert.ok(scoreHits.every((item) => item.cacheKey !== 'img_score_old'));
assert.ok(scoreHits.every((item) => item.cacheKey !== 'img_score_future'));

console.log('imageMemoryIndex.test.js passed');

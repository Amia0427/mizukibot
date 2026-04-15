const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-dailyshare-engine-'));
process.env.DATA_DIR = tempRoot;
process.env.DAILY_SHARE_STATE_FILE = path.join(tempRoot, 'daily_share_state.json');
process.env.DAILY_SHARE_TARGETS_FILE = path.join(tempRoot, 'daily_share_targets.json');
process.env.QZONE_GENERATION_HISTORY_FILE = path.join(tempRoot, 'qzone_generation_history.json');
process.env.DAILY_SHARE_QZONE_ENABLED = 'true';
process.env.API_KEY = process.env.API_KEY || 'test-key';

const { createDailyShareEngine } = require('../core/dailyShareEngine');
const { recordQzoneGenerationHistory, getRecentQzoneHistory } = require('../core/qzoneGenerationState');

recordQzoneGenerationHistory({
  source: 'daily_share',
  text: '我把夜里的风声听了一会儿，忽然就不想把话说满了。',
  topicKey: 'daily-night',
  topicGroup: 'daily',
  variationProfile: {
    lens: 'scene',
    emotion: 'blank',
    anchor: 'window',
    structure: 'two_step',
    ending: 'soft_close'
  },
  type: 'mood',
  at: Date.now() - 1000
});
recordQzoneGenerationHistory({
  source: 'bot_diary',
  text: '我又把歌单切回去了，像给自己找一个借口继续发呆。',
  topicKey: 'media-playlist',
  topicGroup: 'media',
  variationProfile: {
    lens: 'object',
    emotion: 'soft',
    anchor: 'music',
    structure: 'short_then_turn',
    ending: 'hanging'
  },
  type: 'recommendation',
  at: Date.now()
});

let publishedText = '';
const engine = createDailyShareEngine({
  qzonePublisher: async (text) => {
    publishedText = String(text || '');
    return { success: true, reason: 'ok', source: 'test' };
  },
  runMemoryCli: async () => ({ ok: false }),
  recordMemoryScope: () => {},
  memoryQueryPlanner: async () => ({ query: 'qzone mood' })
});

(async () => {
  const result = await engine.handleAdminCommand({
    rawText: '/dailyshare qzone run mood',
    groupId: 'test-group',
    userId: '1960901788',
    sendWithRetry: async () => true,
    askAIByGraph: async (_question, _userInfo, _userId, customPrompt, _imageUrl, options = {}) => {
      assert.ok(options.modelConfig);
      assert.ok(String(customPrompt).includes('[本次写法槽位]'));
      return '我把杯子抱在手里发了一会儿呆，最后还是把窗帘拉开了一点。';
    },
    date: new Date('2026-04-15T22:10:00+08:00')
  });

  assert.strictEqual(result.handled, true);
  assert.ok(publishedText.includes('我'));
  const history = getRecentQzoneHistory();
  assert.ok(history.some((item) => item.source === 'daily_share'));
  assert.ok(history.some((item) => item.type === 'mood'));

  console.log('dailyShareEngine.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

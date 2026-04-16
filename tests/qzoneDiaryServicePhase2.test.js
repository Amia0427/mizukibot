const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-qzone-diary-phase2-'));
process.env.DATA_DIR = tempRoot;
process.env.QZONE_GENERATION_HISTORY_FILE = path.join(tempRoot, 'qzone_generation_history.json');
process.env.QZONE_GENERATION_LOG_FILE = path.join(tempRoot, 'qzone_generation_log.json');
process.env.QZONE_VISUAL_HISTORY_FILE = path.join(tempRoot, 'qzone_visual_history.json');
process.env.API_KEY = process.env.API_KEY || 'test-key';

const { generateBotDiaryDraft, generateGenericQzoneDraft } = require('../api/qzoneDiaryService');
const { loadQzoneGenerationLog } = require('../core/qzoneGenerationPhase2');

(async () => {
  const botDiary = await generateBotDiaryDraft({
    groupId: 'g1',
    hint: '偏夜里，别太甜'
  }, {
    requestAssistantMessage: async () => ({ content: '我把窗帘拉开一点以后，灯光刚好落在杯口上，原本想继续装作什么都没看见，结果还是被那点安静磨得没那么硬。桌边的杯子还温着，外面雨声轻得像有人把话收回去，我也只好承认今晚确实有点想慢一点。' }),
    recentMessages: [
      { sender_id: '1', sender_name: 'A', text: '今天好困', timestamp: Date.now() - 1000 },
      { sender_id: '2', sender_name: 'B', text: '窗外在下雨', timestamp: Date.now() - 900 }
    ],
    presence: {
      state: 'observing',
      last_action: 'no_reply',
      human_turns_since_bot_reply: 2
    },
    runBotDiaryMemoryPrefetch: async () => ({
      ok: true,
      query: 'bot diary',
      memoryOwner: '3326471600',
      searchCount: 0,
      searchDigestLines: ['无命中，按当前状态自然生成。'],
      searchPayload: { ok: true, count: 0, items: [] },
      openUsed: false,
      openedRef: '',
      openedMemorySummary: '',
      memoryFailureStage: ''
    }),
    recordMemoryScope: () => {}
  });

  assert.strictEqual(botDiary.ok, true);
  assert.ok(botDiary.meta.planFingerprint);
  assert.ok(botDiary.meta.imageIntent);
  assert.ok(botDiary.meta.spark || botDiary.meta.plan?.variationProfile?.spark);
  assert.ok(botDiary.meta.tropeFingerprint);
  assert.ok(botDiary.meta.variantType);

  const genericDraft = await generateGenericQzoneDraft({
    requestText: '写一条偏冷一点的空间说说',
    groupId: 'g1'
  }, {
    requestAssistantMessage: async () => ({ content: '我把手边那盏灯开得很低，刚好够我装作今晚没什么想说的。窗外那点风声倒是很会添乱，偏要把人心里那点没整理好的情绪吹起来一点。' })
  });

  assert.strictEqual(genericDraft.ok, true);
  assert.ok(genericDraft.meta.planFingerprint);
  assert.ok(genericDraft.meta.tropeFingerprint);
  assert.ok(genericDraft.meta.variantType);
  assert.ok(typeof genericDraft.meta.circleNaturalnessScore === 'number');

  const logs = loadQzoneGenerationLog();
  assert.ok(logs.items.some((item) => item.source === 'bot_diary'));
  assert.ok(logs.items.some((item) => item.source === 'generic_autodraft'));

  console.log('qzoneDiaryServicePhase2.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

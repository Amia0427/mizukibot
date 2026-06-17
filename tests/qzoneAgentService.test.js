const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-qzone-agent-'));
process.env.DATA_DIR = tempRoot;
process.env.QZONE_GENERATION_HISTORY_FILE = path.join(tempRoot, 'qzone_generation_history.json');
process.env.QZONE_GENERATION_LOG_FILE = path.join(tempRoot, 'qzone_generation_log.json');
process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.QZONE_HUMANIZE_PUBLISH_DELAY_ENABLED = 'false';

const { resolveQzonePublishDelayMs, runQzoneAgent } = require('../api/qzoneAgentService');
const { getRecentQzoneHistory } = require('../core/qzoneGenerationState');
const { loadQzoneGenerationLog } = require('../core/qzoneGenerationPhase2');

(async () => {
  let publishCalls = 0;
  const draft = await runQzoneAgent({
    mode: 'manual',
    content: '我把消息框关掉之后，房间突然安静得有点认真。',
    publishPolicy: 'draft_only'
  }, {
    userId: 'admin',
    groupId: 'g1'
  }, {
    assertAdmin: () => {},
    publishQzonePost: async () => {
      publishCalls += 1;
      return { success: true, reason: 'should-not-run' };
    }
  });

  assert.strictEqual(draft.ok, true);
  assert.strictEqual(draft.published, false);
  assert.strictEqual(publishCalls, 0);
  assert.strictEqual(getRecentQzoneHistory().length, 0);
  assert.ok(loadQzoneGenerationLog().items.some((item) => item.status === 'drafted'));

  const deterministicDelay = resolveQzonePublishDelayMs('我把杯子放回桌边，差点忘了自己刚刚想说什么。', {
    planFingerprint: 'delay-test'
  }, {
    humanizePublishDelayEnabled: true,
    humanizePublishDelayMinMs: 10,
    humanizePublishDelayMaxMs: 20
  });
  assert.ok(deterministicDelay >= 10 && deterministicDelay <= 20);

  const observedDelays = [];
  const published = await runQzoneAgent({
    mode: 'manual',
    content: '我把杯子抱在手里发了一会儿呆，最后还是把窗帘拉开了一点。',
    publishPolicy: 'auto_publish',
    source: 'scheduled_qzone_post',
    type: 'agent'
  }, {
    userId: 'admin',
    groupId: 'g1'
  }, {
    assertAdmin: () => {},
    qzoneAutoPublishEnabled: true,
    humanizePublishDelayEnabled: true,
    humanizePublishDelayMinMs: 10,
    humanizePublishDelayMaxMs: 20,
    sleep: async (ms) => {
      observedDelays.push(ms);
    },
    publishQzonePost: async (content) => {
      publishCalls += 1;
      assert.ok(String(content).includes('我'));
      return { success: true, reason: 'ok', source: 'test' };
    }
  });

  assert.strictEqual(published.ok, true);
  assert.strictEqual(published.published, true);
  assert.strictEqual(publishCalls, 1);
  assert.strictEqual(observedDelays.length, 1);
  assert.ok(published.meta.humanizedDelayApplied);
  assert.ok(published.meta.humanizedDelayMs >= 10 && published.meta.humanizedDelayMs <= 20);
  assert.ok(getRecentQzoneHistory().some((item) => item.source === 'scheduled_qzone_post'));
  assert.ok(loadQzoneGenerationLog().items.some((item) => item.status === 'sent'));

  const disabledPublish = await runQzoneAgent({
    mode: 'manual',
    content: '我把自动发布关掉以后，只留下草稿就够了。',
    publishPolicy: 'auto_publish',
    source: 'scheduled_qzone_post',
    type: 'agent'
  }, {
    userId: 'admin',
    groupId: 'g1'
  }, {
    assertAdmin: () => {},
    qzoneAutoPublishEnabled: false,
    publishQzonePost: async () => {
      throw new Error('disabled auto publish should not call QZone publisher');
    }
  });

  assert.strictEqual(disabledPublish.ok, true);
  assert.strictEqual(disabledPublish.published, false);
  assert.strictEqual(disabledPublish.draftOnly, true);
  assert.strictEqual(disabledPublish.reason, 'QZone auto publish disabled');
  assert.strictEqual(publishCalls, 1);

  const blockedByUncertainImageUpload = await runQzoneAgent({
    mode: 'manual',
    content: '我把灯关掉以后，桌上的杯影反而像醒着。',
    publishPolicy: 'auto_publish',
    imagePromptHints: ['quiet desk lamp', 'soft cup shadow']
  }, {
    userId: 'admin',
    groupId: 'g1'
  }, {
    assertAdmin: () => {},
    qzoneAutoPublishEnabled: true,
    helpers: {
      tryGenerateBotDiaryQzoneImage: async () => ({
        attempted: true,
        generated: true,
        uploaded: true,
        imagePublishMode: 'image_generated',
        imageFallbackStage: '',
        imageProviderUsed: 'test-provider',
        imagePath: path.join(tempRoot, 'qzone-image.png')
      }),
      cleanupLocalImage: () => {}
    },
    publishQzonePostWithImages: async () => ({
      success: false,
      uncertain: true,
      reason: 'image upload timeout',
      source: 'test-image'
    }),
    publishQzonePost: async () => {
      throw new Error('text publish should be blocked after uncertain image upload');
    }
  });

  assert.strictEqual(blockedByUncertainImageUpload.ok, false);
  assert.strictEqual(blockedByUncertainImageUpload.published, false);
  assert.strictEqual(blockedByUncertainImageUpload.reason, 'image upload timeout');

  console.log('qzoneAgentService.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

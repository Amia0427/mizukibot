const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const axios = require('axios');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-qqaction-'));
process.env.DATA_DIR = tempRoot;
process.env.QZONE_GENERATION_HISTORY_FILE = path.join(tempRoot, 'qzone_generation_history.json');
process.env.ADMIN_USER_IDS = 'u-admin';
process.env.API_KEY = process.env.API_KEY || 'test-key';

const {
  buildBotDiaryImagePrompt,
  createScheduledCommand,
  downloadImageToLocal,
  isNightDiaryWindow,
  publishQzoneForContext,
  sanitizeDiaryImageText,
  sendGroupImageMessage,
  setMessageEmojiLike
} = require('../api/qqActionService');
const { createNapCatHttpActionClient } = require('../api/napcatHttpActionClient');
const { getRecentQzoneHistory } = require('../core/qzoneGenerationState');

(async () => {
  const actionCalls = [];
  const imageResult = await sendGroupImageMessage('g-img', Buffer.from('test-image'), {
    actionClient: {
      async callAction(action, params) {
        actionCalls.push({ action, params });
        return { ok: true };
      }
    }
  });

  assert.strictEqual(imageResult.success, true);
  assert.strictEqual(actionCalls.length, 1);
  assert.strictEqual(actionCalls[0].action, 'send_group_msg');
  assert.ok(Array.isArray(actionCalls[0].params.message));
  assert.strictEqual(actionCalls[0].params.message[0].type, 'image');
  assert.ok(String(actionCalls[0].params.message[0].data.file || '').startsWith('base64://'));

  const downloaded = await downloadImageToLocal(
    `data:image/png;base64,${Buffer.from('downloaded-image').toString('base64')}`,
    { tmpDir: tempRoot }
  );
  assert.strictEqual(downloaded.ok, true);
  const fileImageResult = await sendGroupImageMessage('g-file-img', { file: downloaded.path }, {
    actionClient: {
      async callAction(action, params) {
        actionCalls.push({ action, params });
        return { ok: true };
      }
    }
  });
  assert.strictEqual(fileImageResult.success, true);
  assert.ok(String(actionCalls[1].params.message[0].data.file || '').includes(Buffer.from('downloaded-image').toString('base64')));

  assert.strictEqual(isNightDiaryWindow({ hour: 23 }), true);
  assert.strictEqual(sanitizeDiaryImageText('今晚 23:59 看 http://example.com 群号123456'), '今晚 看');
  assert.ok(buildBotDiaryImagePrompt('今天写日记', { weekday: 'Friday', timeBucket: 'night' }).includes('open diary'));

  const draftResult = await publishQzoneForContext('我把消息框关掉之后，房间突然安静得有点认真。', {
    userId: 'u-admin',
    routeMeta: {
      groupId: 'g1'
    }
  }, {
    publishQzonePost: async () => {
      throw new Error('draft_only must not publish');
    }
  });

  assert.strictEqual(draftResult.ok, true);
  assert.strictEqual(draftResult.published, false);

  const result = await publishQzoneForContext('我把消息框关掉之后，房间突然安静得有点认真。', {
    userId: 'u-admin',
    routeMeta: {
      groupId: 'g1'
    }
  }, {
    publishPolicy: 'auto_publish',
    qzoneSource: 'manual_qzone_post',
    qzoneType: 'manual_qzone_post',
    lens: 'scene',
    emotion: 'aloof',
    anchor: 'room',
    structure: 'murmur_close',
    ending: 'cold_turn',
    qzoneAutoPublishEnabled: true,
    publishQzonePost: async (content) => {
      assert.ok(String(content).includes('我'));
      return { success: true, reason: 'ok', source: 'test' };
    }
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.published, true);
  const history = getRecentQzoneHistory();
  assert.ok(history.some((item) => item.source === 'manual_qzone_post'));
  assert.ok(history.some((item) => item.lens === 'scene'));

  const createdTasks = [];
  assert.throws(() => createScheduledCommand('qzone_post', 'tomorrow 09:00', {
    mode: 'agent',
    hint: '不应该创建'
  }, {
    userId: 'u-admin',
    routeMeta: {
      groupId: 'g1'
    }
  }, {
    qzoneAutoPublishEnabled: false,
    store: {
      createTask(task) {
        createdTasks.push(task);
        return { task: { id: 'unexpected', ...task } };
      }
    }
  }), /QZone auto publish disabled/);
  assert.strictEqual(createdTasks.length, 0);

  const emojiCalls = [];
  const emojiResult = await setMessageEmojiLike('m1', [14], {
    actionClient: {
      isConnected: () => false,
      getConnectionState: () => ({ connected: false, readyStateName: 'closed' }),
      async callAction(action, params) {
        emojiCalls.push({ action, params });
      }
    }
  });
  assert.strictEqual(emojiResult.success, false);
  assert.strictEqual(emojiResult.reason, 'napcat_offline');
  assert.strictEqual(emojiResult.skipped, true);
  assert.strictEqual(emojiCalls.length, 0, 'offline thinking emoji should not call NapCat');

  const timedEmojiCalls = [];
  const timedEmojiResult = await setMessageEmojiLike('m2', [355], {
    timeoutMs: 2345,
    actionClient: {
      isConnected: () => true,
      async callAction(action, params, options) {
        timedEmojiCalls.push({ action, params, options });
      }
    }
  });
  assert.strictEqual(timedEmojiResult.success, true);
  assert.strictEqual(timedEmojiCalls.length, 1);
  assert.strictEqual(timedEmojiCalls[0].action, 'set_msg_emoji_like');
  assert.strictEqual(timedEmojiCalls[0].options.timeoutMs, 2345);

  const originalAxiosPost = axios.post;
  const httpActionCalls = [];
  try {
    axios.post = async (url, body, options) => {
      httpActionCalls.push({ url, body, options });
      return { data: { status: 'ok', retcode: 0, data: { ok: true } } };
    };
    const httpActionClient = createNapCatHttpActionClient();
    await httpActionClient.callAction('set_msg_emoji_like', {
      message_id: 'm3',
      emoji_id: 355,
      set: true
    }, { timeoutMs: 2345 });
  } finally {
    axios.post = originalAxiosPost;
  }
  assert.strictEqual(httpActionCalls.length, 1);
  assert.strictEqual(httpActionCalls[0].options.timeout, 2345);

  console.log('qqActionService.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

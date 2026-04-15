const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-qqaction-'));
process.env.DATA_DIR = tempRoot;
process.env.QZONE_GENERATION_HISTORY_FILE = path.join(tempRoot, 'qzone_generation_history.json');
process.env.ADMIN_USER_IDS = 'u-admin';
process.env.API_KEY = process.env.API_KEY || 'test-key';

const { publishQzoneForContext } = require('../api/qqActionService');
const { getRecentQzoneHistory } = require('../core/qzoneGenerationState');

(async () => {
  const result = await publishQzoneForContext('我把消息框关掉之后，房间突然安静得有点认真。', {
    userId: 'u-admin',
    routeMeta: {
      groupId: 'g1'
    }
  }, {
    qzoneSource: 'manual_qzone_post',
    qzoneType: 'manual_qzone_post',
    lens: 'scene',
    emotion: 'aloof',
    anchor: 'room',
    structure: 'murmur_close',
    ending: 'cold_turn',
    publishQzonePost: async (content) => {
      assert.ok(String(content).includes('我'));
      return { success: true, reason: 'ok', source: 'test' };
    }
  });

  assert.strictEqual(result.ok, true);
  const history = getRecentQzoneHistory();
  assert.ok(history.some((item) => item.source === 'manual_qzone_post'));
  assert.ok(history.some((item) => item.lens === 'scene'));

  console.log('qqActionService.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

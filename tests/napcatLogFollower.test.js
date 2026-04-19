const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-follower-'));
  const logPath = path.join(tmpDir, 'napcat.jsonl');

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.ADMIN_USER_IDS = '10001';
    process.env.BOT_QQ = '3326471600';
    process.env.FOLLOWER_RULE_ENABLED = 'true';
    process.env.FOLLOWER_LOG_MONITOR_ENABLED = 'true';
    process.env.FOLLOWER_NAPCAT_LOG_PATH = logPath;
    process.env.PASSIVE_AWARENESS_REPLY_API_BASE_URL = 'https://example.com/v1';
    process.env.PASSIVE_AWARENESS_REPLY_API_KEY = 'reply-test-key';
    process.env.PASSIVE_AWARENESS_REPLY_MODEL = 'reply-test-model';

    clearProjectCache();

    const httpClient = require('../api/httpClient');
    httpClient.postStreamWithRetry = async (_url, _payload, handlers) => {
      if (handlers && typeof handlers.onData === 'function') {
        handlers.onData('data: {"choices":[{"delta":{"content":"模型插话"}}]}\n\n');
        handlers.onData('data: [DONE]\n\n');
      }
    };

    const {
      appendNapcatPacketToLog,
      createNapcatLogFollower
    } = require('../core/napcatLogFollower');

    const sentReplies = [];
    const follower = createNapcatLogFollower({
      sendGroupReply: async (payload) => {
        sentReplies.push(payload);
        return true;
      }
    });

    await follower.handlePacketFromLog({
      post_type: 'message',
      message_type: 'group',
      self_id: '3326471600',
      group_id: 'g1',
      user_id: '10001',
      message_id: 'm1',
      raw_message: '大家继续',
      sender: {
        card: '管理员甲',
        nickname: '管理员甲'
      }
    });

    assert.strictEqual(sentReplies.length, 1, 'admin non-at-bot group message should trigger follower reply');
    assert.strictEqual(sentReplies[0].groupId, 'g1');
    assert.strictEqual(sentReplies[0].senderId, '10001');

    await follower.handleLivePacket({
      post_type: 'message',
      message_type: 'group',
      self_id: '3326471600',
      group_id: 'g1',
      user_id: '10001',
      message_id: 'm1-live',
      raw_message: '实时直通',
      sender: {
        card: '管理员甲',
        nickname: '管理员甲'
      }
    });

    assert.strictEqual(sentReplies.length, 2, 'live packet should trigger the same follower path');

    await follower.handlePacketFromLog({
      post_type: 'message',
      message_type: 'group',
      self_id: '3326471600',
      group_id: 'g1',
      user_id: '10001',
      message_id: 'm2',
      raw_message: '[CQ:at,qq=3326471600] 你来答',
      sender: {
        card: '管理员甲',
        nickname: '管理员甲'
      }
    });

    assert.strictEqual(sentReplies.length, 2, 'direct @bot message should not be handled by follower');

    appendNapcatPacketToLog({
      post_type: 'message',
      message_type: 'group',
      self_id: '3326471600',
      group_id: 'g1',
      user_id: '10001',
      message_id: 'm3',
      raw_message: '写入日志',
      sender: {
        card: '管理员甲',
        nickname: '管理员甲'
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1, 'message log appender should write one json line');
    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.group_id, 'g1');
    assert.strictEqual(parsed.user_id, '10001');

    console.log('napcatLogFollower.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

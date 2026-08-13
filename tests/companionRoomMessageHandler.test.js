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

function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) if (!(key in snapshot)) delete process.env[key];
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

function privateMessage(id, text, userId = 'allowed_user') {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bot_test',
    user_id: userId,
    message_id: id,
    raw_message: text,
    message: text,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, nickname: userId }
  };
}

module.exports = (async () => {
  const env = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-room-handler-'));
  try {
    process.env.DATA_DIR = tempDir;
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.BOT_QQ = 'bot_test';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.CONTINUOUS_MESSAGE_ENABLED = 'false';
    process.env.PRIVATE_CHAT_TEST_USER_IDS = 'allowed_user,admin-only';
    process.env.ADMIN_USER_IDS = 'admin-only';
    clearProjectCache();

    const calls = [];
    const sent = [];
    let afterReplySentCalls = 0;
    let intentCalls = 0;
    const companionRoomRuntime = {
      async handleAdminCommand(input) {
        calls.push({ kind: 'admin', input });
        if (input.rawText === '/陪伴插件 开启') return { handled: true, code: 'enabled', replyText: '已开启' };
        return { handled: false };
      },
      async handleUserMessage(input) {
        calls.push({ kind: 'user', input });
        if (input.rawText.startsWith('/陪伴')) return {
          handled: true,
          code: 'started',
          replyText: '房间已开始',
          afterReplySent: () => { afterReplySentCalls += 1; }
        };
        return { handled: false };
      }
    };
    const { createMessageHandler } = require('../core/messageHandler');
    const config = require('../config');
    const { handleIncomingMessage } = createMessageHandler({
      config,
      companionRoomRuntime,
      sendWithRetry: async (payload) => { sent.push(payload); return true; },
      detectIntentHybridOverride: async () => { intentCalls += 1; return { topRouteType: 'direct_chat', cleanText: '普通消息', rawText: '普通消息', question: '普通消息', intent: { risk: 'low', toolNeed: ['none'], executionMode: 'immediate', needsPlanning: false, needsMemory: false }, facets: { modality: 'text', sourceScope: 'none', domain: 'general', outputKind: 'answer', freshness: 'unknown' }, meta: {} }; }
    });

    await handleIncomingMessage(privateMessage('start-1', '/陪伴 开始 专注 15分钟'));
    assert.strictEqual(intentCalls, 0);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].params.message, '房间已开始');
    assert.strictEqual(afterReplySentCalls, 1);

    await handleIncomingMessage(privateMessage('admin-1', '/陪伴插件 开启', 'admin-only'));
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[1].params.message, '已开启');
    assert.strictEqual(calls.find((call) => call.input.rawText === '/陪伴插件 开启').input.isAdmin, true);

    console.log('companionRoomMessageHandler.test.js passed');
  } finally {
    require('../utils/sqliteRuntime').closeLoadedSqliteConnections();
    restoreEnv(env);
    clearProjectCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

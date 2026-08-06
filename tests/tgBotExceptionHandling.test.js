const assert = require('assert');
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

function createMessage(overrides = {}) {
  return {
    message_id: 'tg-msg-1',
    text: 'hello',
    from: { id: 'tg-user-1' },
    chat: { id: 'tg-chat-1' },
    ...overrides
  };
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const originalConsoleError = console.error;
  const errors = [];

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.TG_ALLOWED_CHAT_IDS = '';
    clearProjectCache();

    console.error = (...args) => {
      errors.push(args);
    };

    const { handleTelegramMessage } = require('../core/tgBot');

    const dispatched = [];
    const bot = {
      async getFileLink(fileId) {
        return `https://api.telegram.org/file/${fileId}`;
      }
    };
    await assert.doesNotReject(handleTelegramMessage(bot, createMessage(), {
      botInfo: { id: 'tg-bot-1', username: 'mizuki_bot' },
      onMessage: async (message, source) => dispatched.push({ message, source })
    }));
    assert.strictEqual(dispatched.length, 1);
    assert.strictEqual(dispatched[0].message.platform, 'telegram');
    assert.strictEqual(dispatched[0].message.text, 'hello');
    assert.strictEqual(dispatched[0].source, 'telegram_polling_compat');

    await assert.doesNotReject(handleTelegramMessage(bot, createMessage({ message_id: 'tg-dispatch-fail' }), {
      onMessage: async () => {
        throw new Error('主管线处理失败');
      }
    }));
    assert.ok(errors.some((entry) => String(entry[0]).includes('message dispatch failed')));

    await assert.doesNotReject(handleTelegramMessage({
      async sendChatAction() {
        throw new Error('should not be called without chat id');
      },
      async sendMessage() {
        throw new Error('should not be called without chat id');
      }
    }, { message_id: 'tg-missing-chat', text: 'hello' }, {
      onMessage: async () => {
        throw new Error('should not dispatch without chat id');
      }
    }));

    console.log('tgBotExceptionHandling.test.js passed');
  } finally {
    console.error = originalConsoleError;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

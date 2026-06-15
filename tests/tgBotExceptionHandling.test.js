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

    const typingFailureSends = [];
    await assert.doesNotReject(handleTelegramMessage({
      async sendChatAction() {
        throw new Error('telegram typing failed');
      },
      async sendMessage(chatId, text) {
        typingFailureSends.push({ chatId, text });
      }
    }, createMessage(), {
      askAIByGraph: async () => 'reply after typing failure'
    }));
    assert.deepStrictEqual(typingFailureSends, [{
      chatId: 'tg-chat-1',
      text: 'reply after typing failure'
    }]);
    assert.ok(errors.some((entry) => String(entry[0]).includes('sendChatAction failed')));

    let fallbackAttempts = 0;
    await assert.doesNotReject(handleTelegramMessage({
      async sendChatAction() {},
      async sendMessage() {
        fallbackAttempts += 1;
        throw new Error('telegram send failed');
      }
    }, createMessage({ message_id: 'tg-msg-ai-fail' }), {
      askAIByGraph: async () => {
        throw new Error('model failed');
      }
    }));
    assert.strictEqual(fallbackAttempts, 1, 'AI failure should attempt exactly one fallback message');
    assert.ok(errors.some((entry) => String(entry[0]).includes('AI processing failed')));
    assert.ok(errors.some((entry) => String(entry[0]).includes('sendMessage failed')));

    const chunkAttempts = [];
    let chunkSendCount = 0;
    await assert.doesNotReject(handleTelegramMessage({
      async sendChatAction() {},
      async sendMessage(chatId, text) {
        chunkSendCount += 1;
        chunkAttempts.push({ chatId, textLength: String(text).length });
        if (chunkSendCount === 1) {
          throw new Error('first chunk failed');
        }
      }
    }, createMessage({ message_id: 'tg-msg-chunks' }), {
      askAIByGraph: async () => 'x'.repeat(3501)
    }));
    assert.deepStrictEqual(chunkAttempts, [
      { chatId: 'tg-chat-1', textLength: 3500 },
      { chatId: 'tg-chat-1', textLength: 1 }
    ]);

    await assert.doesNotReject(handleTelegramMessage({
      async sendChatAction() {
        throw new Error('should not be called without chat id');
      },
      async sendMessage() {
        throw new Error('should not be called without chat id');
      }
    }, { message_id: 'tg-missing-chat', text: 'hello' }, {
      askAIByGraph: async () => {
        throw new Error('should not call AI without chat id');
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

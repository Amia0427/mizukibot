const assert = require('assert');
const path = require('path');

module.exports = (async () => {
  const envSnapshot = { ...process.env };
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  const listenersBefore = new Map([
    ['beforeExit', new Set(process.listeners('beforeExit'))],
    ['exit', new Set(process.listeners('exit'))],
    ['SIGINT', new Set(process.listeners('SIGINT'))],
    ['SIGTERM', new Set(process.listeners('SIGTERM'))],
    ['SIGBREAK', new Set(process.listeners('SIGBREAK'))],
    ['SIGHUP', new Set(process.listeners('SIGHUP'))],
    ['mizuki:restartScheduled', new Set(process.listeners('mizuki:restartScheduled'))]
  ]);

  try {
    process.env.MIZUKIBOT_INDEX_TEST_MODE = '1';
    process.env.API_KEY = process.env.API_KEY || 'test-api-key';
    process.env.ENABLE_DEBUG_LOG = 'false';
    process.env.FOLLOWER_DIRECT_DISPATCH_ENABLED = 'false';
    process.env.FOLLOWER_RULE_ENABLED = 'false';
    process.env.MESSAGE_INGRESS_ASYNC_ENABLED = 'true';
    process.env.TICK_ENGINE_ENABLED = 'false';
    process.env.SCHEDULER_RUNTIME_ENABLED = 'false';
    process.env.POST_REPLY_WORKER_INLINE = 'false';
    process.env.VOICE_INPUT_ENABLED = 'false';

    const { __test } = require('../index');
    const runtimeConfig = require('../config');
    assert.strictEqual(runtimeConfig.VOICE_INPUT_ENABLED, false);
    assert.strictEqual(runtimeConfig.VOICE_INPUT_API_URL, 'https://api.siliconflow.cn/v1/audio/transcriptions');
    assert.strictEqual(runtimeConfig.VOICE_INPUT_MODEL, 'XingChenAGI/XingChenASR-V3.2-Ultra');
    assert.strictEqual(runtimeConfig.VOICE_INPUT_TIMEOUT_MS, 60000);
    assert.strictEqual(runtimeConfig.VOICE_INPUT_MAX_BYTES, 5 * 1024 * 1024);
    assert.strictEqual(runtimeConfig.VOICE_INPUT_MAX_CONCURRENCY, 4);
    const enqueued = [];
    __test.setMessageIngressDispatcherForTest({
      enqueue(message, meta) {
        enqueued.push({ message, meta });
        return true;
      }
    });

    const voiceInputService = {
      async prepare(message) {
        return {
          consumed: false,
          message: {
            ...message,
            raw_message: '[CQ:at,qq=100] 请评价这首歌 [语音转写] 夜空中最亮的星',
            message: message.message.map((segment) => segment.type === 'record'
              ? { type: 'text', data: { text: ' [语音转写] 夜空中最亮的星' } }
              : segment)
          }
        };
      }
    };
    const napcatMessage = {
      post_type: 'message',
      message_type: 'group',
      message_id: 'voice-ingress-1',
      self_id: '100',
      user_id: '200',
      group_id: '300',
      raw_message: '[CQ:at,qq=100] 请评价这首歌 [CQ:record,file=voice.silk]',
      message: [
        { type: 'at', data: { qq: '100' } },
        { type: 'text', data: { text: '请评价这首歌' } },
        { type: 'record', data: { file: 'voice.silk' } }
      ]
    };
    assert.strictEqual(await __test.acceptNapCatIncomingMessage(
      napcatMessage,
      'voice_test',
      () => false,
      { voiceInputService }
    ), true);
    assert.strictEqual(enqueued.length, 1);
    assert.strictEqual(enqueued[0].meta.source, 'voice_test');
    assert.strictEqual(enqueued[0].message.raw_message, '[CQ:at,qq=100] 请评价这首歌 [语音转写] 夜空中最亮的星');
    assert.strictEqual(enqueued[0].message.canonical_message.text, '请评价这首歌 [语音转写] 夜空中最亮的星');
    assert.strictEqual(enqueued[0].message.message.some((segment) => segment.type === 'record'), false);

    const consumedService = {
      async prepare() {
        return { message: null, consumed: true };
      }
    };
    assert.strictEqual(await __test.acceptNapCatIncomingMessage(
      { ...napcatMessage, message_id: 'voice-ingress-2' },
      'voice_test',
      () => false,
      { voiceInputService: consumedService }
    ), false);
    assert.strictEqual(enqueued.length, 1);
  } finally {
    for (const [eventName, listeners] of listenersBefore) {
      for (const listener of process.listeners(eventName)) {
        if (!listeners.has(listener)) process.removeListener(eventName, listener);
      }
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
    for (const cacheKey of Object.keys(require.cache)) {
      if (cacheKey.startsWith(projectRoot)) delete require.cache[cacheKey];
    }
  }

  console.log('voiceInputIngress.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

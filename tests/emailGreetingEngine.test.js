const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailGreetingEngine } = require('../src/features/email-greetings/engine');
const { createEmailGreetingStateStore } = require('../src/features/email-greetings/store');

function createFixture(prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateStore = createEmailGreetingStateStore(path.join(tempDir, 'state.json'));
  stateStore.updateUser('10001', (user) => {
    user.status = 'active';
    user.email = 'user@example.com';
    user.displayName = '小明';
  }, { flushNow: true });
  return stateStore;
}

function config() {
  return {
    EMAIL_GREETING_ENABLED: true,
    EMAIL_GREETING_SEND_TIME: '09:00',
    EMAIL_GREETING_SCAN_INTERVAL_MS: 60000,
    TIMEZONE: 'Asia/Shanghai'
  };
}

function events() {
  return [
    { id: 'qixi', name: '七夕', kind: 'holiday', date: '2026-08-19' },
    { id: 'anniversary_1', name: '相识纪念日', kind: 'anniversary', date: '2026-08-19' }
  ];
}

function modelReply() {
  return {
    content: JSON.stringify({
      subject: '今天也要开心',
      greeting: '小明，七夕快乐',
      body: '愿今天的你有轻松而明亮的心情。',
      closing: '瑞希'
    })
  };
}

(async () => {
  const timestamp = Date.parse('2026-08-19T10:00:00+08:00');
  const stateStore = createFixture('email-greeting-engine-');
  const sent = [];
  const engine = createEmailGreetingEngine({
    config: config(),
    stateStore,
    getEvents: () => events(),
    askAIByGraph: async () => modelReply(),
    mailer: { send: async (message) => sent.push(message) },
    now: () => timestamp
  });
  const result = await engine.scan({ now: timestamp });
  assert.strictEqual(result.results[0].status, 'sent');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(stateStore.getDelivery('10001', '2026-08-19').events.length, 2);
  await engine.scan({ now: timestamp });
  assert.strictEqual(sent.length, 1);

  const retryStore = createFixture('email-greeting-engine-model-retry-');
  let modelCalls = 0;
  const retryEngine = createEmailGreetingEngine({
    config: config(),
    stateStore: retryStore,
    getEvents: () => events(),
    askAIByGraph: async () => {
      modelCalls += 1;
      if (modelCalls === 1) throw new Error('model unavailable');
      return modelReply();
    },
    mailer: { send: async () => true },
    now: () => timestamp
  });
  await retryEngine.scan({ now: timestamp });
  assert.strictEqual(retryStore.getDelivery('10001', '2026-08-19').status, 'retry_wait');
  await retryEngine.scan({ now: timestamp + (10 * 60 * 1000) });
  assert.strictEqual(retryStore.getDelivery('10001', '2026-08-19').status, 'sent');
  assert.strictEqual(modelCalls, 2);

  const smtpStore = createFixture('email-greeting-engine-smtp-retry-');
  let smtpCalls = 0;
  let smtpModelCalls = 0;
  const smtpEngine = createEmailGreetingEngine({
    config: config(),
    stateStore: smtpStore,
    getEvents: () => events(),
    askAIByGraph: async () => {
      smtpModelCalls += 1;
      return modelReply();
    },
    mailer: {
      send: async () => {
        smtpCalls += 1;
        if (smtpCalls < 3) throw new Error('smtp unavailable');
        return true;
      }
    },
    now: () => timestamp
  });
  await smtpEngine.scan({ now: timestamp });
  await smtpEngine.scan({ now: timestamp + (10 * 60 * 1000) });
  await smtpEngine.scan({ now: timestamp + (70 * 60 * 1000) });
  assert.strictEqual(smtpCalls, 3);
  assert.strictEqual(smtpModelCalls, 1);
  assert.strictEqual(smtpStore.getDelivery('10001', '2026-08-19').status, 'sent');
  console.log('emailGreetingEngine.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

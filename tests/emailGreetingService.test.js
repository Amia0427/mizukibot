const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailGreetingSubscriptionService } = require('../src/features/email-greetings/service');
const { createEmailGreetingStateStore } = require('../src/features/email-greetings/store');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-greeting-service-'));
let timestamp = Date.parse('2026-08-19T09:00:00+08:00');
const messages = [];
const stateStore = createEmailGreetingStateStore(path.join(tempDir, 'state.json'), { now: () => timestamp });
const service = createEmailGreetingSubscriptionService({
  stateStore,
  mailer: { send: async (message) => messages.push(message) },
  now: () => timestamp,
  createCode: () => '123456'
});

(async () => {
  assert.deepStrictEqual(await service.requestSubscription('10001', 'not-an-email'), { status: 'invalid_email' });
  const subscribed = await service.requestSubscription('10001', 'User@example.com', '小明');
  assert.strictEqual(subscribed.status, 'verification_sent');
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(stateStore.getUser('10001').status, 'pending');
  assert.strictEqual(service.verify('10001', '000000').status, 'invalid_code');
  assert.strictEqual(service.verify('10001', '123456').status, 'verified');
  assert.strictEqual(stateStore.getUser('10001').status, 'active');

  assert.strictEqual(service.setHoliday('10001', '七夕', false).status, 'holiday_disabled');
  assert.strictEqual(service.getStatus('10001').disabledHolidayIds.includes('qixi'), true);
  assert.strictEqual(service.addAnniversary('10001', '相识纪念日', '08-19').status, 'anniversary_added');
  assert.strictEqual(service.addAnniversary('10001', '相识纪念日', '08-19').status, 'duplicate_anniversary');
  assert.strictEqual(service.listAnniversaries('10001').anniversaries.length, 1);
  assert.strictEqual(service.removeAnniversary('10001', '相识纪念日').status, 'anniversary_removed');
  assert.strictEqual(service.unsubscribe('10001').status, 'unsubscribed');
  assert.strictEqual(stateStore.getUser('10001').status, 'inactive');

  await service.requestSubscription('10002', 'second@example.com');
  timestamp += 16 * 60 * 1000;
  assert.strictEqual(service.verify('10002', '123456').status, 'expired');
  console.log('emailGreetingService.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

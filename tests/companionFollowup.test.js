const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createCompanionFollowupService,
  createFollowupStateStore
} = require('../src/features/companion-followups');

module.exports = (() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizukibot-followup-'));
  const stateFile = path.join(tempDir, 'followups.json');
  const now = Date.parse('2026-08-25T04:00:00.000Z');
  const store = createFollowupStateStore(stateFile, { now: () => now });
  const service = createCompanionFollowupService({
    config: {
      DATA_DIR: tempDir,
      TIMEZONE: 'Asia/Shanghai'
    },
    now: () => now,
    store
  });

  try {
    const created = service.execute('user-a', {
      action: 'add',
      title: '准备考试材料',
      note: '先整理错题本',
      due_at: '今天 13:00'
    });
    assert.strictEqual(created.item.id, 'followup_1');
    assert.strictEqual(created.item.userId, 'user-a');
    assert.strictEqual(created.item.dueAt, '2026-08-25 13:00');

    const otherUserItems = service.execute('user-b', { action: 'list' });
    assert.deepStrictEqual(otherUserItems.items, []);

    const listed = service.execute('user-a', { action: 'list' });
    assert.strictEqual(listed.items.length, 1);
    assert.strictEqual(listed.items[0].title, '准备考试材料');

    const snoozed = service.execute('user-a', {
      action: 'snooze',
      id: created.item.id,
      due_at: '2小时后'
    });
    assert.strictEqual(snoozed.item.status, 'snoozed');
    assert.strictEqual(snoozed.item.dueAt, '2026-08-25 14:00');

    const completed = service.execute('user-a', { action: 'complete', id: created.item.id });
    assert.strictEqual(completed.item.status, 'completed');
    assert.deepStrictEqual(service.execute('user-a', { action: 'list' }).items, []);
    assert.strictEqual(service.execute('user-a', { action: 'list', include_closed: true }).items.length, 1);

    const second = service.execute('user-a', { action: 'add', title: '提交作业', due_at: '今天 11:00' });
    const context = service.getContext('user-a', now);
    assert.strictEqual(context.length, 1);
    assert.strictEqual(context[0].id, second.item.id);
    assert.strictEqual(context[0].overdue, true);

    assert.throws(
      () => service.execute('user-a', { action: 'complete', id: 'followup_999' }),
      /follow-up not found/
    );
    assert.throws(
      () => service.execute('user-a', { action: 'add', title: '每天复习', due_at: '每天 20:00' }),
      /只支持一次性时间/
    );

    console.log('companionFollowup.test.js passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();

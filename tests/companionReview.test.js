const assert = require('assert');

const { createCompanionReviewService } = require('../src/features/companion-review');

module.exports = (() => {
  const now = Date.parse('2026-08-25T16:30:00.000Z');
  const requested = [];
  const journalByDay = {
    '2026-08-19': {
      source: 'profile_journal_db',
      byLayer: {
        daily: [{ day: '2026-08-19', text: '完成了旧计划。' }],
        segment: [],
        activeRaw: []
      }
    },
    '2026-08-24': {
      source: 'profile_journal_db',
      byLayer: {
        daily: [],
        segment: [{ startDay: '2026-08-24', endDay: '2026-08-24', text: '聊了考试准备。' }],
        activeRaw: []
      }
    },
    '2026-08-25': {
      source: 'profile_journal_db',
      byLayer: {
        daily: [],
        segment: [],
        activeRaw: [{
          day: '2026-08-25',
          entries: [{ userText: '今天有点累', assistantText: '那就先休息一下。' }]
        }]
      }
    }
  };
  const service = createCompanionReviewService({
    config: { TIMEZONE: 'Asia/Shanghai' },
    now: () => now,
    getDailyJournalRetrievalBundle(userId, options) {
      requested.push({ userId, day: options.day });
      return journalByDay[options.day] || { byLayer: {} };
    },
    followupService: {
      list(userId) {
        assert.strictEqual(userId, 'user-a');
        return [{ title: '整理错题本', dueAt: '2026-08-26 20:00', note: '先整理数学' }];
      }
    }
  });

  const today = service.execute('user-a', { range: 'today' });
  assert.deepStrictEqual(today.days, ['2026-08-26']);
  assert.deepStrictEqual(today.recordedDays, []);
  assert.strictEqual(today.hasJournal, false);
  assert.strictEqual(today.followUps.length, 1);

  const yesterday = service.execute('user-a', { range: 'yesterday' });
  assert.deepStrictEqual(yesterday.days, ['2026-08-25']);
  assert.strictEqual(yesterday.reviews[0].text, '你：今天有点累\n瑞希：那就先休息一下。');

  const week = service.execute('user-a', { range: 'week' });
  assert.deepStrictEqual(week.days, [
    '2026-08-20',
    '2026-08-21',
    '2026-08-22',
    '2026-08-23',
    '2026-08-24',
    '2026-08-25',
    '2026-08-26'
  ]);
  assert.deepStrictEqual(week.recordedDays, ['2026-08-24', '2026-08-25']);
  assert.strictEqual(week.reviews[0].text, '聊了考试准备。');
  assert.strictEqual(week.reviews[1].text, '你：今天有点累\n瑞希：那就先休息一下。');
  assert.ok(requested.every((item) => item.userId === 'user-a'));
  assert.throws(() => service.execute('user-a', { range: 'month' }), /range 不支持/);
  assert.throws(() => service.execute('', { range: 'today' }), /private userId/);

  console.log('companionReview.test.js passed');
})();

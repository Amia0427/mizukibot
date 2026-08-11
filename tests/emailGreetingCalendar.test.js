const assert = require('assert');
const { getEventsForDate, normalizeAnniversary } = require('../src/features/email-greetings/calendar');

function dateAtNoon(dateKey) {
  return new Date(`${dateKey}T12:00:00+08:00`);
}

const qixi = getEventsForDate(dateAtNoon('2026-08-19'), 'Asia/Shanghai');
assert.deepStrictEqual(qixi.map((event) => event.id), ['qixi']);

const springFestival = getEventsForDate(dateAtNoon('2026-02-17'), 'Asia/Shanghai');
assert.deepStrictEqual(springFestival.map((event) => event.id), ['spring_festival']);

const merged = getEventsForDate(dateAtNoon('2026-08-19'), 'Asia/Shanghai', {
  anniversaries: [{ id: 'a1', name: '相识纪念日', date: '08-19', annual: true }]
});
assert.deepStrictEqual(merged.map((event) => event.name), ['七夕', '相识纪念日']);

const disabled = getEventsForDate(dateAtNoon('2026-08-19'), 'Asia/Shanghai', {
  disabledHolidayIds: ['qixi'],
  anniversaries: [{ id: 'a1', name: '相识纪念日', date: '08-19', annual: true }]
});
assert.deepStrictEqual(disabled.map((event) => event.name), ['相识纪念日']);

assert.deepStrictEqual(normalizeAnniversary({ name: '生日', date: '02-29' }), {
  id: '',
  name: '生日',
  date: '02-29',
  annual: true
});
assert.strictEqual(normalizeAnniversary({ name: '错误日期', date: '2026-02-29' }), null);

console.log('emailGreetingCalendar.test.js passed');

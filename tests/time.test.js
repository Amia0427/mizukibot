'use strict';

const assert = require('assert');
const { getDatePartsInTz, isPastTimeToday } = require('../utils/time');

const midnight = new Date('2026-05-19T16:16:00.000Z');
const parts = getDatePartsInTz(midnight, 'Asia/Shanghai');

assert.deepStrictEqual(parts, {
  year: 2026,
  month: 5,
  day: 20,
  hour: 0,
  minute: 16,
  second: 0
});
assert.strictEqual(isPastTimeToday('00:15', midnight, 'Asia/Shanghai'), true);
assert.strictEqual(isPastTimeToday('00:17', midnight, 'Asia/Shanghai'), false);

console.log('time.test.js passed');

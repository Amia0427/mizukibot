const assert = require('assert');

const {
  armCotOnce,
  buildCotSessionKey,
  cleanupExpiredCotSessions,
  consumeCotOnce,
  peekCotOnce
} = require('../utils/cotOnceRuntime');

module.exports = (() => {
  cleanupExpiredCotSessions(Date.now() + 10 * 60 * 1000);

  const groupKey = buildCotSessionKey({ chatType: 'group', groupId: 'g1', userId: 'u1' });
  const privateKey = buildCotSessionKey({ chatType: 'private', userId: 'u1' });
  assert.strictEqual(groupKey, 'group:g1:user:u1');
  assert.strictEqual(privateKey, 'direct:u1');

  const armed = armCotOnce({ chatType: 'group', groupId: 'g1', userId: 'u1' });
  assert.ok(armed);
  assert.strictEqual(peekCotOnce({ chatType: 'group', groupId: 'g1', userId: 'u1' }).sessionKey, groupKey);
  assert.strictEqual(peekCotOnce({ chatType: 'group', groupId: 'g2', userId: 'u1' }), null);

  const consumed = consumeCotOnce({ chatType: 'group', groupId: 'g1', userId: 'u1' });
  assert.ok(consumed);
  assert.strictEqual(peekCotOnce({ chatType: 'group', groupId: 'g1', userId: 'u1' }), null);

  const privateArmed = armCotOnce({ chatType: 'private', userId: 'u2' });
  assert.ok(privateArmed);
  cleanupExpiredCotSessions(Number(privateArmed.expiresAt || 0) + 1);
  assert.strictEqual(peekCotOnce({ chatType: 'private', userId: 'u2' }), null);

  console.log('cotOnceRuntime.test.js passed');
})();

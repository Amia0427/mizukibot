const assert = require('assert');
const {
  createEmotionGate,
  evaluateEmotionGate,
  resolveEmotionCooldownKey
} = require('../core/replyVisual');

assert.strictEqual(evaluateEmotionGate({ emotion: 'neutral', intensity: 'high', confidence: 1 }).allowed, false);
assert.strictEqual(evaluateEmotionGate({ emotion: 'happy', intensity: 'medium', confidence: 1 }).allowed, false);
assert.strictEqual(evaluateEmotionGate({ emotion: 'happy', intensity: 'high', confidence: 0.69 }).allowed, false);
assert.strictEqual(evaluateEmotionGate({ emotion: 'happy', intensity: 'high', confidence: 0.7 }).allowed, true);
assert.strictEqual(resolveEmotionCooldownKey({ chatType: 'private', userId: 'u1' }), 'private:u1');
assert.strictEqual(resolveEmotionCooldownKey({ chatType: 'group', groupId: 'g1' }), 'group:g1');

const gate = createEmotionGate({ minConfidence: 0.7, cooldownMs: 1000 });
const analysis = { emotion: 'happy', intensity: 'high', confidence: 0.8 };
assert.strictEqual(gate.check('private:u1', analysis, 1000).allowed, true);
gate.markSent('private:u1', 1000);
assert.strictEqual(gate.check('private:u1', analysis, 1500).reason, 'cooldown');
assert.strictEqual(gate.check('group:g1', analysis, 1500).allowed, true);

console.log('live2dEmotionGate.test.js passed');

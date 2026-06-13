const assert = require('assert');

const {
  buildGeminiRecentStyleGuardPrompt,
  extractGeminiRecentStyleSignal,
  isGeminiRecentStyleGuardEligible,
  recordGeminiRecentStyleSignal
} = require('../utils/geminiRecentStyleGuard');

(() => {
  const signal = extractGeminiRecentStyleSignal('诶——你这也太犯规了呢♪');
  assert.deepStrictEqual(signal.openingAnchors, ['诶——']);
  assert.ok(signal.stockPhrases.includes('犯规'));
  assert.ok(signal.tailParticles.includes('♪'));

  assert.strictEqual(isGeminiRecentStyleGuardEligible({
    modelName: 'gemini-3-flash-preview',
    routeMeta: { chatType: 'group' }
  }), true);
  assert.strictEqual(isGeminiRecentStyleGuardEligible({
    modelName: 'gemini-3-flash-preview',
    userId: 'admin_1',
    routeMeta: { chatType: 'private' },
    config: { ADMIN_USER_IDS: ['admin_1'] }
  }), false);

  const store = { records: [] };
  const first = recordGeminiRecentStyleSignal({
    assistantText: '诶——这个特殊奖励有点犯规喔',
    modelName: 'gemini-3-flash-preview',
    userId: 'user_1',
    groupId: 'group_1',
    routePolicyKey: 'group_chat/default',
    topRouteType: 'direct_chat',
    routeMeta: { chatType: 'group', groupId: 'group_1' },
    store
  });
  assert.strictEqual(first.recorded, true);

  recordGeminiRecentStyleSignal({
    assistantText: '呜哇，这个秘密小彩蛋真的有点犯规呢',
    modelName: 'gemini-3-flash-preview',
    userId: 'user_1',
    groupId: 'group_1',
    routePolicyKey: 'group_chat/default',
    topRouteType: 'direct_chat',
    routeMeta: { chatType: 'group', groupId: 'group_1' },
    store
  });

  assert.strictEqual(store.records.length, 2);
  assert.ok(!JSON.stringify(store).includes('这个特殊奖励有点犯规喔'), 'store must keep derived style signals only');

  const prompt = buildGeminiRecentStyleGuardPrompt({
    modelName: 'gemini-3-flash-preview',
    userId: 'user_1',
    groupId: 'group_1',
    routePolicyKey: 'group_chat/default',
    topRouteType: 'direct_chat',
    routeMeta: { chatType: 'group', groupId: 'group_1' },
    store
  });
  assert.ok(prompt.includes('[GeminiRecentStyleGuard]'));
  assert.ok(prompt.includes('诶——'));
  assert.ok(prompt.includes('呜哇'));
  assert.ok(prompt.includes('犯规x2'));
  assert.ok(prompt.includes('不要解释这条规则'));

  const adminPrompt = buildGeminiRecentStyleGuardPrompt({
    modelName: 'gemini-3-flash-preview',
    userId: 'admin_1',
    routeMeta: { chatType: 'private' },
    config: { ADMIN_USER_IDS: ['admin_1'] },
    store
  });
  assert.strictEqual(adminPrompt, '');

  console.log('geminiRecentStyleGuard.test.js passed');
})();

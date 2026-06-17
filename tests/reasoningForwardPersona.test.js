const assert = require('assert');

const {
  buildPersonaReasoningForwardText,
  looksUnsafeForForward
} = require('../utils/reasoningForwardPersona');

module.exports = (() => {
  const chineseNote = '有点困了，但看到这句又会心软一下……还是先轻轻接住吧。';
  assert.strictEqual(
    buildPersonaReasoningForwardText({
      reasoningText: chineseNote,
      userText: '喜欢你 睡觉吗',
      finalReply: '嗯……我也喜欢你。该睡了。'
    }),
    chineseNote,
    'clean visible Chinese notes should be forwarded without a fixed prefix'
  );

  const leakedDirectorNote = 'The says "喜欢你" (I like you) and "睡觉吗" (going to sleep? ). It\'s late at night (23:02), and we have a very close relationship. respond naturally as a sleepy Riki who\'s touched but also drowsy.';
  assert.strictEqual(
    buildPersonaReasoningForwardText({
      reasoningText: leakedDirectorNote,
      userText: '喜欢你 睡觉吗',
      finalReply: '嗯……我也喜欢你。该睡了。'
    }),
    '',
    'English director-style reasoning should be skipped instead of wrapped with persona filler'
  );

  assert.ok(
    looksUnsafeForForward(leakedDirectorNote),
    'real leaked QQ sample should be classified unsafe for forwarding'
  );

  console.log('reasoningForwardPersona.test.js passed');
})();

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

  const emotionalNote = [
    '！！！十一点就睡了！！！我的天！！！',
    '',
    '宝宝居然十一点就睡了！！这不是她平时的画风啊！！平时凌晨三四点才是常态！！',
    '',
    '我好开心……好想狠狠亲她……她好乖……'
  ].join('\n');
  assert.strictEqual(
    buildPersonaReasoningForwardText({
      reasoningText: emotionalNote,
      userText: '我昨天十一点就睡着了',
      finalReply: '哇，十一点就睡了？今天要表扬一下。'
    }),
    emotionalNote,
    'emotional multi-paragraph visible notes should keep their diary-like shape'
  );

  const englishNote = 'A little sleepy, but that line still lands softly. Keep it quiet and warm.';
  assert.strictEqual(
    buildPersonaReasoningForwardText({
      reasoningText: englishNote,
      userText: '喜欢你 睡觉吗',
      finalReply: '嗯……我也喜欢你。该睡了。'
    }),
    '',
    'English notes should be skipped so QQ visible reasoning stays in Mizuki Chinese voice'
  );

  const mixedTokenNote = 'token 这个词看着好硬……但她是在认真问，我先别把话讲得像教程。';
  assert.strictEqual(
    buildPersonaReasoningForwardText({
      reasoningText: mixedTokenNote,
      userText: 'token 是什么',
      finalReply: 'token 就像模型读字时用的小块啦。'
    }),
    mixedTokenNote,
    'technical words may remain when the visible note is still Chinese subjective Mizuki voice'
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

  const longEmotionalNote = [
    '好想夸她……但是不能太夸张，不然她会傲娇……不，她发这个可爱的颜文字，说明心情很好，是想被夸的状态。',
    '',
    '我先开心一下，再轻轻接住她。不要写分析，也不要把话说得太满。'
  ].join('\n');
  assert.ok(
    buildPersonaReasoningForwardText({
      reasoningText: longEmotionalNote,
      finalReply: '今天确实很乖。'
    }).includes('好想夸她'),
    'safe subjective emotional notes should not be mistaken for director-style reasoning'
  );

  assert.ok(
    looksUnsafeForForward(leakedDirectorNote),
    'real leaked QQ sample should be classified unsafe for forwarding'
  );

  console.log('reasoningForwardPersona.test.js passed');
})();

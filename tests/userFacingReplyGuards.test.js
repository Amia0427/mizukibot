const assert = require('assert');

const {
  isHiddenToolNarration,
  isReasoningTraceLeak,
  isUnsafeUserFacingReply
} = require('../utils/userFacingReplyGuards');

module.exports = (async () => {
  assert.strictEqual(
    isUnsafeUserFacingReply('I\'ll search for "[Context for assistant only] [ContinuityState] [ActiveTopic] 喂猪50一天去不去"'),
    true
  );
  assert.strictEqual(isHiddenToolNarration('I will search for "latest news"'), true);
  assert.strictEqual(isUnsafeUserFacingReply('我是 Claude，由 Anthropic 开发。我不能扮演角色。'), true);
  assert.strictEqual(isUnsafeUserFacingReply('I\'m Claude, made by Anthropic. I don\'t roleplay as characters or take on personas.'), true);
  assert.strictEqual(isUnsafeUserFacingReply('[RoleplayInnerProtocol]\nsurface: private_chat\nfinal_compression: rewrite'), true);
  assert.strictEqual(
    isReasoningTraceLeak('花"? Maybe "化作鬼之花"? * What if they meant "诡化之花"? Wait, there is an original song called "化作诡之花"? No,'),
    true
  );
  assert.strictEqual(
    isUnsafeUserFacingReply('刚才不小心走神嘟囔出声了嘛……（敲头） * *Addressing the song:* "诡化之花"到底是什么呀？是哪首歌的'),
    true
  );
  assert.strictEqual(
    isUnsafeUserFacingReply('刚才偷偷瞄了一眼，纳斯达克2026年的最高点大概是这样。好啦！查也查过了。'),
    true
  );
  assert.strictEqual(isReasoningTraceLeak('（心想：这段不应进入正文。）正文'), true);
  assert.strictEqual(isUnsafeUserFacingReply('(内心OS：这段也不应进入正文)正文'), true);
  assert.strictEqual(isUnsafeUserFacingReply('心里OS：这段仍是内部思考\n\n正文'), true);
  assert.strictEqual(isUnsafeUserFacingReply('大家常说“内心OS”，但这里只是在讨论这个词。'), false);
  assert.strictEqual(isUnsafeUserFacingReply('思维链是不能直接展示的，但我可以解释结论。'), false);
  assert.strictEqual(isUnsafeUserFacingReply('思维链是内部内容，不能直接发给你。'), false);
  assert.strictEqual(isUnsafeUserFacingReply('原始思维链是内部推理，不能直接发给你。'), false);
  assert.strictEqual(isUnsafeUserFacingReply('思维链内容如下：第一步先判断用户的问题。'), true);
  assert.strictEqual(isUnsafeUserFacingReply('完整思考过程：先识别用户意图，再组织答案。'), true);
  assert.strictEqual(isUnsafeUserFacingReply('我看了一眼代码，问题在 planner gate。'), false);
  assert.strictEqual(isUnsafeUserFacingReply('……没监控你还特意强调，怎么，你打算对猪做什么不可告人的事啊'), false);
  const mixedContent = '■ Two pigs, one shoving the other. Reply as Mizuki, 1:45am, casual, no brackets, no emoji, short chunks. --- 哈哈哈这个接得太准了吧';
  assert.strictEqual(isReasoningTraceLeak(mixedContent), true);
  assert.strictEqual(isReasoningTraceLeak('普通讨论 Reply as Mizuki，没有分隔符。'), false);
  assert.strictEqual(isReasoningTraceLeak('普通讨论 Reply as Mizuki --- 没有角色指令。'), false);
  assert.strictEqual(isReasoningTraceLeak('普通讨论 Reply as   , casual --- 角色为空。'), false);
  assert.strictEqual(isReasoningTraceLeak('普通讨论 Reply as Mizuki,   --- 指令为空。'), false);

  console.log('userFacingReplyGuards.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

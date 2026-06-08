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
  assert.strictEqual(isUnsafeUserFacingReply('我看了一眼代码，问题在 planner gate。'), false);
  assert.strictEqual(isUnsafeUserFacingReply('……没监控你还特意强调，怎么，你打算对猪做什么不可告人的事啊'), false);

  console.log('userFacingReplyGuards.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

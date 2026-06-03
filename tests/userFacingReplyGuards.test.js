const assert = require('assert');

const {
  isHiddenToolNarration,
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
  assert.strictEqual(isUnsafeUserFacingReply('……没监控你还特意强调，怎么，你打算对猪做什么不可告人的事啊'), false);

  console.log('userFacingReplyGuards.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

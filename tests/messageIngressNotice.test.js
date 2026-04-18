const assert = require('assert');

const { shouldHandleNotice } = require('../core/messageIngress');

(() => {
  const inputNotice = shouldHandleNotice({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'input_status',
    user_id: 'u1',
    event_type: 1,
    status_text: '对方正在输入...'
  }, { BOT_QQ: 'bot_1' });

  assert.strictEqual(inputNotice.handled, true);
  assert.strictEqual(inputNotice.type, 'input_status');
  assert.strictEqual(inputNotice.meta.userId, 'u1');
  assert.strictEqual(inputNotice.meta.eventType, '1');
  assert.strictEqual(inputNotice.meta.statusText, '对方正在输入...');
  assert.strictEqual(inputNotice.meta.isPrivate, true);

  const groupMembershipNotice = shouldHandleNotice({
    post_type: 'notice',
    notice_type: 'group_decrease',
    sub_type: 'kick_me',
    user_id: 'bot_1',
    self_id: 'bot_1',
    group_id: 'g1'
  }, { BOT_QQ: 'bot_1' });

  assert.strictEqual(groupMembershipNotice.handled, true);
  assert.strictEqual(groupMembershipNotice.type, 'group_membership');

  const ignoredNotice = shouldHandleNotice({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'something_else'
  }, { BOT_QQ: 'bot_1' });

  assert.strictEqual(ignoredNotice.handled, true);
  assert.strictEqual(ignoredNotice.type, 'ignored_notice');

  console.log('messageIngressNotice.test.js passed');
})();

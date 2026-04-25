const assert = require('assert');

const { classifyReplyFailure } = require('../utils/replyFailure');

assert.strictEqual(
  classifyReplyFailure('status=403 | response={"error":{"code":"insufficient_user_quota","message":"预扣费额度失败, 用户剩余额度: ＄0.05"}}').type,
  'provider_quota'
);

assert.strictEqual(
  classifyReplyFailure('invalid api key').type,
  'provider_auth'
);

console.log('replyFailure.test.js passed');

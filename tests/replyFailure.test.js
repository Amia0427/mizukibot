const assert = require('assert');

const { classifyReplyFailure } = require('../utils/replyFailure');

assert.strictEqual(
  classifyReplyFailure('status=403 | response={"error":{"code":"insufficient_user_quota","message":"预扣费额度失败, 用户剩余额度: ＄0.05"}}').type,
  'provider_quota'
);

assert.strictEqual(
  classifyReplyFailure('status=429 | response={"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 159h55m54s."}}').type,
  'provider_quota'
);

assert.strictEqual(
  classifyReplyFailure('status=529 | response={"error":{"message":"All available accounts exhausted","type":"server_error"}}').type,
  'provider_quota'
);

assert.strictEqual(
  classifyReplyFailure('status=402 | response={"error":{"message":"insufficient balance","type":"server_error"}}').type,
  'provider_quota'
);

assert.strictEqual(
  classifyReplyFailure('invalid api key').type,
  'provider_auth'
);

console.log('replyFailure.test.js passed');

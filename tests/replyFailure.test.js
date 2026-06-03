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

assert.strictEqual(
  classifyReplyFailure('这边配置像是没扣好，先检查一下模型钥匙吧。').type,
  'provider_auth'
);

assert.strictEqual(
  classifyReplyFailure('模型额度好像见底了。先换个模型或者补一下额度，我再继续。').type,
  'provider_quota'
);

assert.strictEqual(
  classifyReplyFailure('刚刚那句被卡掉了。你换个更短更明确的说法，我马上接。').type,
  'provider_blocked'
);

assert.strictEqual(
  classifyReplyFailure('刚刚那句没组织稳。你再发一次，我继续接。').type,
  'generic_model_failure'
);

console.log('replyFailure.test.js passed');

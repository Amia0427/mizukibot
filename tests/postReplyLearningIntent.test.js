const assert = require('assert');

const {
  detectPostReplyLearningIntent,
  isExplicitRememberText,
  mergeLearningIntent
} = require('../utils/postReplyWorker/learningIntent');

module.exports = (() => {
  assert.strictEqual(isExplicitRememberText('记住我喜欢直接一点'), true);
  assert.strictEqual(isExplicitRememberText('Turn 2 User: remember coffee means focus'), true);
  assert.strictEqual(isExplicitRememberText('今天只是闲聊一下'), false);

  assert.strictEqual(detectPostReplyLearningIntent({
    turns: [{ question: '记一下我喜欢稳定画像' }],
    tasks: { memoryLearning: true }
  }), 'explicit');
  assert.strictEqual(detectPostReplyLearningIntent({
    turns: [{ question: '普通聊天' }],
    tasks: { memoryLearning: true }
  }), 'implicit');
  assert.strictEqual(detectPostReplyLearningIntent({
    turns: [{ question: '普通聊天' }],
    tasks: { dailyJournal: true }
  }), 'journal_only');
  assert.strictEqual(mergeLearningIntent('journal_only', 'implicit', 'explicit'), 'explicit');

  console.log('postReplyLearningIntent.test.js passed');
})();

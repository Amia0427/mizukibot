const assert = require('assert');

const {
  detectPostReplyLearningIntent,
  isExplicitRememberText,
  mergeLearningIntent
} = require('../utils/postReplyWorker/learningIntent');
const {
  buildPostReplyJobWithoutRecapTurns,
  filterPostReplyRecapTurns,
  isPostReplyRecapText
} = require('../utils/postReplyWorker/recapPolicy');

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
  assert.strictEqual(isPostReplyRecapText('宝说一下我们今天聊的'), true);
  assert.strictEqual(isPostReplyRecapText('宝我今天发给你什么战绩图了'), true);
  assert.strictEqual(isPostReplyRecapText('我们刚才聊到哪了'), false);
  assert.strictEqual(isPostReplyRecapText('记住我们今天聊的这条规则'), false);
  const filtered = filterPostReplyRecapTurns([
    { turnId: 'keep', question: '今天打音游好累', finalReply: '先休息一下。' },
    { turnId: 'skip', question: '宝说一下我们今天聊的', finalReply: '今天聊了音游。' }
  ]);
  assert.deepStrictEqual(filtered.turns.map((turn) => turn.turnId), ['keep']);
  assert.strictEqual(filtered.skippedCount, 1);
  const targetLikeEnrich = buildPostReplyJobWithoutRecapTurns({
    phase: 'enrich',
    question: '宝说一下我们今天聊的',
    turns: [
      { turnId: 'normal', question: '今天打音游好累', finalReply: '先休息一下。' },
      { turnId: 'recap-latest', question: '宝说一下我们今天聊的', finalReply: '今天聊了音游。' }
    ]
  });
  assert.strictEqual(targetLikeEnrich.job, null);
  assert.strictEqual(targetLikeEnrich.skippedCount, 1);

  console.log('postReplyLearningIntent.test.js passed');
})();

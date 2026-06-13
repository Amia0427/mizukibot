const assert = require('assert');
const {
  buildLiveStateContext,
  buildLiveStateForState,
  fitLiveStateTokenBudget,
  LIVE_STATE_TOKEN_LIMIT
} = require('../utils/liveState');
const { getAntiAIRules } = require('../utils/liveState/antiAIRules');
const { getCurrentActivity } = require('../utils/liveState/currentActivity');
const {
  buildBoundary,
  getDefaultBoundary,
  getRelationshipBoundary
} = require('../utils/liveState/relationshipBoundary');
const { estimateTokens } = require('../utils/contextBudget');

(async () => {
  const stranger = getDefaultBoundary();
  assert.strictEqual(stranger.level, 'stranger');
  assert.ok(stranger.boundary.includes('保持礼貌距离'));

  const friend = buildBoundary({
    relationType: 'friend',
    closeness: 65,
    intimacy: 44,
    lastInteractionAt: new Date(Date.now() - 10 * 86400000).toISOString()
  });
  assert.strictEqual(friend.level, 'friend');
  assert.ok(friend.boundary.includes('朋友'));
  assert.ok(friend.boundary.includes('很久没联系'));
  assert.ok(friend.boundary.includes('不会读心'));

  const projected = await getRelationshipBoundary('u_projection', {
    memoryV3: {
      async queryProjection(type, query) {
        assert.strictEqual(type, 'relationship');
        assert.strictEqual(query.targetId, 'mizuki_akiyama');
        return [{ relationType: 'close', closeness: 80, intimacy: 70, tags: ['frequent_chat'] }];
      }
    }
  });
  assert.strictEqual(projected.level, 'close');
  assert.deepStrictEqual(projected.tags, ['frequent_chat']);

  const night = getCurrentActivity({ now: new Date('2026-06-14T02:00:00+08:00'), timezone: 'Asia/Shanghai' });
  assert.ok(night.activity.includes('睡觉'));
  assert.strictEqual(night.mood, '困倦');
  assert.ok(night.constraints.includes('简短'));

  const workdayAfternoon = getCurrentActivity({ now: new Date('2026-06-17T15:00:00+08:00'), timezone: 'Asia/Shanghai' });
  assert.ok(workdayAfternoon.activity.includes('学校或排练'));
  assert.strictEqual(workdayAfternoon.mood, '专注');

  const rules = getAntiAIRules({
    hasTools: true,
    userMessageLength: 5,
    recentTurnCount: 12
  });
  assert.ok(rules.core.includes('禁止"我是AI助手"'));
  assert.ok(rules.scenario.some((item) => item.includes('回复也可以简短')));
  assert.ok(rules.scenario.some((item) => item.includes('可以自然结束话题')));
  assert.ok(rules.scenario.some((item) => item.includes('不要说"让我帮你查一下"')));

  const liveStateText = buildLiveStateContext({
    relationship: projected,
    activity: night,
    recentContext: '最近聊了乐队排练的事',
    antiAIRules: rules,
    currentTime: new Date('2026-06-14T02:00:00+08:00'),
    timezone: 'Asia/Shanghai'
  });
  assert.ok(liveStateText.includes('【生活状态补充】'));
  assert.ok(liveStateText.includes('【与这个用户的关系】'));
  assert.ok(liveStateText.includes('【重要：真人反应约束】'));

  const fitted = fitLiveStateTokenBudget(liveStateText + '\n'.repeat(10) + '补充'.repeat(1000));
  assert.ok(estimateTokens(fitted) <= LIVE_STATE_TOKEN_LIMIT);
  assert.ok(fitted.includes('【重要：真人反应约束】'));
  assert.ok(fitted.includes('【与这个用户的关系】'));

  const built = await buildLiveStateForState({
    request: {
      userId: 'u_projection',
      question: '好',
      allowedTools: ['weather'],
      topRouteType: 'direct_chat'
    },
    messages: []
  }, {
    now: new Date('2026-06-14T02:00:00+08:00'),
    timezone: 'Asia/Shanghai',
    memoryV3: {
      async queryProjection() {
        return [{ relationType: 'friend', closeness: 55, intimacy: 30 }];
      }
    },
    dailyJournal: {
      async queryRecent() {
        return [{ summary: '用户问了新曲进度' }];
      }
    }
  });
  assert.ok(built.context.includes('用户问了新曲进度'));
  assert.ok(built.tokens <= LIVE_STATE_TOKEN_LIMIT);

  console.log('liveState.test.js passed');
})();

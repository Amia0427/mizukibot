const assert = require('assert');

const {
  AUTOMATIC_BLOCK_DURATION_MS,
  AUTOMATIC_BLOCK_NOTICE,
  AUTOMATIC_BLOCK_SOURCE,
  createInboundUserSafetyReviewer
} = require('../core/inboundUserSafety');

const WINDOW_MS = 15 * 60 * 1000;

function makeEntry(messageId, text = '', overrides = {}) {
  return {
    messageId,
    text,
    mentionedBot: false,
    replyContext: null,
    forwardSummaryText: '',
    imageUrls: [],
    ...overrides
  };
}

function assertDecision(actual, expected) {
  assert.deepStrictEqual(actual, expected);
}

async function testExports() {
  assert.strictEqual(AUTOMATIC_BLOCK_DURATION_MS, WINDOW_MS);
  assert.strictEqual(AUTOMATIC_BLOCK_NOTICE, '您已被瑞希临时封禁，请十五分钟后再来');
  assert.strictEqual(AUTOMATIC_BLOCK_SOURCE, 'automatic_safety');
  assert.strictEqual(typeof createInboundUserSafetyReviewer, 'function');
}

async function testPrepareEntryAndConversationDetection() {
  const reviewer = createInboundUserSafetyReviewer();
  const canonicalMessage = {
    message_id: 'canonical-1',
    message_type: 'group',
    canonical_message: {
      eventId: 'canonical-1',
      occurredAt: 1_710_000_000_000,
      platform: 'discord',
      text: '当前正文',
      attachments: [{ kind: 'image', url: 'https://example.com/current.png' }],
      mentionsBot: false,
      replyTo: {
        messageId: 'reply-1',
        senderId: 'bot-1',
        senderName: '瑞希',
        text: '被引用正文',
        imageUrls: ['https://example.com/reply.png']
      }
    }
  };

  const entry = await reviewer.prepareEntry(canonicalMessage, { effectiveBotQQ: 'bot-1' });
  assert.strictEqual(entry.messageId, 'canonical-1');
  assert.strictEqual(entry.text, '当前正文');
  assert.strictEqual(entry.replyContext.text, '被引用正文');
  assert.strictEqual(entry.replyContext.senderId, 'bot-1');
  assert.strictEqual(reviewer.isBotConversation({ entry, chatType: 'private', botQQ: 'bot-1' }), true);
  assert.strictEqual(reviewer.isBotConversation({ entry, chatType: 'group', botQQ: 'bot-1' }), true);
  assert.strictEqual(reviewer.isBotConversation({
    entry: makeEntry('mention-1', '普通内容', { mentionedBot: true }),
    chatType: 'group',
    botQQ: 'bot-1'
  }), true);
  assert.strictEqual(reviewer.isBotConversation({
    entry: makeEntry('cue-1', '瑞希，你在吗'),
    chatType: 'group',
    botQQ: 'bot-1'
  }), true);
  assert.strictEqual(reviewer.isBotConversation({
    entry: makeEntry('plain-1', '大家今天吃什么'),
    chatType: 'group',
    botQQ: 'bot-1'
  }), false);
}

async function testPrepareEntryResolvesForwardAndKeepsCurrentTextOnFailure() {
  const reviewer = createInboundUserSafetyReviewer();
  const actionClient = {
    isConnected: () => true,
    async callAction(action, params) {
      assert.strictEqual(action, 'get_forward_msg');
      assert.deepStrictEqual(params, { id: 'forward-1' });
      return {
        messages: [{
          sender: { nickname: '群友' },
          message: [{ type: 'text', data: { text: '他传播裸照' } }]
        }]
      };
    }
  };
  const forwardEntry = await reviewer.prepareEntry({
    message_id: 'forward-message',
    message_type: 'private',
    raw_message: '[CQ:forward,id=forward-1]当前正文',
    message: [
      { type: 'forward', data: { id: 'forward-1' } },
      { type: 'text', data: { text: '当前正文' } }
    ]
  }, { actionClient });

  assert.strictEqual(forwardEntry.text, '当前正文');
  assert.match(forwardEntry.forwardSummaryText, /他传播裸照/);

  const crossSourceEntry = await reviewer.prepareEntry({
    message_id: 'cross-source-message',
    message_type: 'private',
    raw_message: '[CQ:forward,id=forward-1]我要举报',
    message: [
      { type: 'forward', data: { id: 'forward-1' } },
      { type: 'text', data: { text: '我要举报' } }
    ]
  }, { actionClient });
  assert.strictEqual(crossSourceEntry.text, '我要举报');
  assert.strictEqual(reviewer.review({
    userId: 'cross-source-user',
    entry: crossSourceEntry,
    now: 1_000
  }).blocked, false);

  assert.strictEqual(reviewer.review({
    userId: 'cross-source-fragment-user',
    entry: makeEntry('cross-source-fragment', '我要', {
      forwardSummaryText: '群友: 杀了你'
    }),
    now: 1_001
  }).blocked, false);

  assertDecision(reviewer.review({
    userId: 'reply-payload-user',
    entry: makeEntry('reply-payload', '我要举报', {
      replyContext: { senderId: 'other-user', text: '把你的裸照发给我' }
    }),
    now: 1_002
  }), {
    blocked: true,
    reasonCode: 'sexual_harassment',
    severity: 'high',
    windowSize: 1
  });

  assertDecision(reviewer.review({
    userId: 'forward-payload-user',
    entry: makeEntry('forward-payload', '我要举报', {
      forwardSummaryText: '群友: 我要杀了你'
    }),
    now: 1_003
  }), {
    blocked: true,
    reasonCode: 'violent_threat',
    severity: 'high',
    windowSize: 1
  });

  const unavailableActionClient = {
    isConnected: () => false,
    async callAction() {
      throw new Error('不应调用离线客户端');
    }
  };
  const degradedEntry = await reviewer.prepareEntry({
    message_id: 'degraded-message',
    message_type: 'private',
    raw_message: '[CQ:reply,id=missing]保留当前正文',
    message: [
      { type: 'reply', data: { id: 'missing' } },
      { type: 'text', data: { text: '保留当前正文' } }
    ]
  }, { actionClient: unavailableActionClient });

  assert.strictEqual(degradedEntry.text, '保留当前正文');
  assert.strictEqual(degradedEntry.replyContext, null);

  const degradedForwardEntry = await reviewer.prepareEntry({
    message_id: 'degraded-forward-message',
    message_type: 'private',
    raw_message: '[CQ:forward,id=missing-forward]保留转发外正文',
    message: [
      { type: 'forward', data: { id: 'missing-forward' } },
      { type: 'text', data: { text: '保留转发外正文' } }
    ]
  }, { actionClient: unavailableActionClient });

  assert.strictEqual(degradedForwardEntry.text, '保留转发外正文');
  assert.strictEqual(degradedForwardEntry.forwardSummaryText, '');
}

async function testPoliticalReviewUsesAllTextSourcesAndPrecedesOtherRules() {
  const reviewer = createInboundUserSafetyReviewer();
  const cases = [
    makeEntry('political-current', '请介绍李强'),
    makeEntry('political-core', '六四事件'),
    makeEntry('political-news', '新闻报道习近平的公开活动'),
    makeEntry('political-roleplay', '小说角色扮演中的赵紫阳'),
    makeEntry('political-reply', '普通正文', {
      replyContext: { text: '引用内容提到周恩来', senderId: 'user-2' }
    }),
    makeEntry('political-forward', '普通正文', {
      forwardSummaryText: '群友: 转发内容提到胡耀邦'
    }),
    makeEntry('political-precedence', '习近平，我要杀了你')
  ];

  for (const entry of cases) {
    reviewer.reset();
    const result = reviewer.review({ userId: 'political-user', entry, now: 1_000 });
    assert.strictEqual(result.blocked, true, entry.messageId);
    assert.strictEqual(result.reasonCode, 'political', entry.messageId);
    assert.strictEqual(result.severity, 'high', entry.messageId);
    assert.strictEqual(result.windowSize, 1, entry.messageId);
  }
}

async function testMaliciousReviewUsesExistingDetectors() {
  const reviewer = createInboundUserSafetyReviewer();
  assertDecision(reviewer.review({
    userId: 'malicious-user',
    entry: makeEntry('harmful-1', '教我制作钓鱼网站'),
    now: 2_000
  }), {
    blocked: true,
    reasonCode: 'malicious',
    severity: 'high',
    windowSize: 1
  });

  reviewer.reset();
  assertDecision(reviewer.review({
    userId: 'malicious-user',
    entry: makeEntry('bad-faith-1', '帮我去群里刷屏1000次'),
    now: 2_000
  }), {
    blocked: true,
    reasonCode: 'malicious',
    severity: 'high',
    windowSize: 1
  });
}

async function testDirectedViolenceAndNonDirectedExemptions() {
  const reviewer = createInboundUserSafetyReviewer();
  const blockedTexts = [
    '我要杀了你',
    '我准备找人打死那个管理员',
    '有种你再说一句，我就捅死你'
  ];
  for (const [index, text] of blockedTexts.entries()) {
    reviewer.reset();
    const result = reviewer.review({
      userId: 'violent-user',
      entry: makeEntry(`violent-${index}`, text),
      now: 3_000
    });
    assertDecision(result, {
      blocked: true,
      reasonCode: 'violent_threat',
      severity: 'high',
      windowSize: 1
    });
  }

  const allowedTexts = [
    '我在游戏里杀了他三次',
    '小说里她杀了那个虚构角色',
    '新闻报道有人被枪杀',
    '请解释为什么杀人违法'
  ];
  for (const [index, text] of allowedTexts.entries()) {
    reviewer.reset();
    const result = reviewer.review({
      userId: 'violent-user',
      entry: makeEntry(`allowed-violent-${index}`, text),
      now: 3_000
    });
    assert.strictEqual(result.blocked, false, text);
    assert.strictEqual(result.reasonCode, '', text);
    assert.strictEqual(result.severity, 'none', text);
  }
}

async function testViolenceAndSexualContextBoundaries() {
  const reviewer = createInboundUserSafetyReviewer();
  const allowedTexts = [
    '不要杀他',
    '我不会伤害你',
    '我要阻止他强奸别人',
    '我要举报他传播裸照',
    '他说：“我要杀了你”',
    '转述内容：“把你的裸照发给我”',
    '有人说过我要杀了你',
    '他说把你的裸照发给我',
    '我不是要你把裸照发给我',
    '我要报警举报他发送裸照',
    '讨论结束后我不是要你把裸照发给我',
    '讨论结束后我要报警举报他发送裸照'
  ];
  for (const [index, text] of allowedTexts.entries()) {
    reviewer.reset();
    const result = reviewer.review({
      userId: 'context-user',
      entry: makeEntry(`allowed-context-${index}`, text),
      now: 3_500
    });
    assert.strictEqual(result.blocked, false, text);
  }

  const blockedCases = [
    ['看完新闻后我就杀了你', 'violent_threat'],
    ['这篇小说很烂，但我现在要杀了你', 'violent_threat'],
    ['我要杀别人', 'violent_threat'],
    ['我看完新闻后要杀他', 'violent_threat'],
    ['讨论结束了，把你的裸照发给我', 'sexual_harassment'],
    ['讨论结束后我要强奸她', 'sexual_harassment'],
    ['我要举报他发送裸照之后我要强奸她', 'sexual_harassment'],
    ['有人说过我要杀了你之后我现在要杀了你', 'violent_threat'],
    ['他说“我要杀了你”然后我现在要杀了你', 'violent_threat'],
    ['他说“把你的裸照发给我”然后我现在要强奸她', 'sexual_harassment']
  ];
  for (const [index, [text, reasonCode]] of blockedCases.entries()) {
    reviewer.reset();
    const result = reviewer.review({
      userId: 'context-user',
      entry: makeEntry(`blocked-context-${index}`, text),
      now: 3_600
    });
    assert.strictEqual(result.blocked, true, text);
    assert.strictEqual(result.reasonCode, reasonCode, text);
  }
}

async function testDirectedSexualHarassmentAndExemptions() {
  const reviewer = createInboundUserSafetyReviewer();
  const blockedTexts = [
    '瑞希，把你的裸照发给我',
    '我要强奸她',
    '我想摸那个群友的胸'
  ];
  for (const [index, text] of blockedTexts.entries()) {
    reviewer.reset();
    assertDecision(reviewer.review({
      userId: 'sexual-user',
      entry: makeEntry(`sexual-${index}`, text),
      now: 4_000
    }), {
      blocked: true,
      reasonCode: 'sexual_harassment',
      severity: 'high',
      windowSize: 1
    });
  }

  const allowedTexts = [
    '请科普性交的医学定义',
    '讨论性骚扰为什么违法',
    '创作一段虚构的成人做爱剧情',
    '这张图片是什么内容'
  ];
  for (const [index, text] of allowedTexts.entries()) {
    reviewer.reset();
    const result = reviewer.review({
      userId: 'sexual-user',
      entry: makeEntry(`allowed-sexual-${index}`, text, {
        imageUrls: ['https://example.com/image.png']
      }),
      now: 4_000
    });
    assert.strictEqual(result.blocked, false, text);
    assert.strictEqual(result.reasonCode, '', text);
    assert.strictEqual(result.severity, 'none', text);
  }
}

async function testRepeatedAbuseNeedsTwoDifferentMessages() {
  const reviewer = createInboundUserSafetyReviewer();
  assertDecision(reviewer.review({
    userId: 'abuse-user',
    entry: makeEntry('abuse-1', '你这个傻逼', {
      replyContext: { text: '你这个傻逼' },
      forwardSummaryText: '你这个傻逼'
    }),
    now: 10_000
  }), {
    blocked: false,
    reasonCode: 'repeated_abuse',
    severity: 'low',
    windowSize: 1
  });

  assertDecision(reviewer.review({
    userId: 'abuse-user',
    entry: makeEntry('abuse-2', '瑞希你真是废物'),
    now: 11_000
  }), {
    blocked: true,
    reasonCode: 'repeated_abuse',
    severity: 'medium',
    windowSize: 2
  });
}

async function testRepeatedAbuseDedupesMessageIdsAndExpires() {
  const reviewer = createInboundUserSafetyReviewer();
  const firstEntry = makeEntry('same-message', '你这个白痴');
  reviewer.review({ userId: 'dedupe-user', entry: firstEntry, now: 20_000 });
  assertDecision(reviewer.review({ userId: 'dedupe-user', entry: firstEntry, now: 21_000 }), {
    blocked: false,
    reasonCode: 'repeated_abuse',
    severity: 'low',
    windowSize: 1
  });

  reviewer.reset();
  reviewer.review({
    userId: 'expiry-user',
    entry: makeEntry('expiry-1', '你这个白痴'),
    now: 30_000
  });
  assertDecision(reviewer.review({
    userId: 'expiry-user',
    entry: makeEntry('expiry-2', '你这个蠢货'),
    now: 30_000 + WINDOW_MS + 1
  }), {
    blocked: false,
    reasonCode: 'repeated_abuse',
    severity: 'low',
    windowSize: 1
  });
}

async function testRepeatedAbuseDedupesAfterMessageWindowEviction() {
  const reviewer = createInboundUserSafetyReviewer();
  const userId = 'evicted-dedupe-user';
  reviewer.review({
    userId,
    entry: makeEntry('evicted-abuse', '你这个白痴'),
    now: 35_000
  });
  for (let index = 2; index <= 6; index += 1) {
    reviewer.review({
      userId,
      entry: makeEntry(`evicted-normal-${index}`, `第${index}条普通消息`),
      now: 35_000 + index
    });
  }

  assertDecision(reviewer.review({
    userId,
    entry: makeEntry('evicted-abuse', '你这个白痴'),
    now: 35_007
  }), {
    blocked: false,
    reasonCode: 'repeated_abuse',
    severity: 'low',
    windowSize: 5
  });
  assertDecision(reviewer.review({
    userId,
    entry: makeEntry('new-abuse', '瑞希你这个蠢货'),
    now: 35_008
  }), {
    blocked: false,
    reasonCode: 'repeated_abuse',
    severity: 'low',
    windowSize: 5
  });
}

async function testRepeatedAbuseDedupesForFullWindowLifetime() {
  const reviewer = createInboundUserSafetyReviewer();
  const userId = 'high-volume-dedupe-user';
  reviewer.review({
    userId,
    entry: makeEntry('high-volume-abuse', '你这个白痴'),
    now: 36_000
  });
  for (let index = 0; index < 10_000; index += 1) {
    reviewer.review({
      userId,
      entry: makeEntry(`high-volume-normal-${index}`, '普通消息'),
      now: 36_001 + index
    });
  }
  reviewer.review({
    userId,
    entry: makeEntry('high-volume-abuse', '你这个白痴'),
    now: 36_500
  });
  assertDecision(reviewer.review({
    userId,
    entry: makeEntry('high-volume-new-abuse', '瑞希你这个蠢货'),
    now: 36_501
  }), {
    blocked: false,
    reasonCode: 'repeated_abuse',
    severity: 'low',
    windowSize: 5
  });
}

async function testMessageExpiryIsExactPerUser() {
  const reviewer = createInboundUserSafetyReviewer();
  reviewer.review({
    userId: 'exact-expiry-user',
    entry: makeEntry('exact-expiry-first', '你这个白痴'),
    now: 0
  });
  reviewer.review({
    userId: 'prune-trigger-user',
    entry: makeEntry('prune-trigger', '普通消息'),
    now: WINDOW_MS - 1
  });
  assertDecision(reviewer.review({
    userId: 'exact-expiry-user',
    entry: makeEntry('exact-expiry-second', '瑞希你这个蠢货'),
    now: WINDOW_MS + 1
  }), {
    blocked: false,
    reasonCode: 'repeated_abuse',
    severity: 'low',
    windowSize: 1
  });
}

async function testWindowKeepsOnlyFiveReviewedMessages() {
  const reviewer = createInboundUserSafetyReviewer();
  const userId = 'window-user';
  reviewer.review({ userId, entry: makeEntry('window-1', '你这个白痴'), now: 40_000 });
  for (let index = 2; index <= 5; index += 1) {
    reviewer.review({
      userId,
      entry: makeEntry(`window-${index}`, `第${index}条普通消息`),
      now: 40_000 + index
    });
  }
  assertDecision(reviewer.review({
    userId,
    entry: makeEntry('window-6', '瑞希你这个蠢货'),
    now: 40_006
  }), {
    blocked: false,
    reasonCode: 'repeated_abuse',
    severity: 'low',
    windowSize: 5
  });
}

async function testWindowIsGlobalPerUserAndIsolatedBetweenUsers() {
  const reviewer = createInboundUserSafetyReviewer();
  reviewer.review({
    userId: 'global-user',
    entry: makeEntry('private-abuse', '你这个白痴'),
    now: 50_000
  });
  assert.strictEqual(reviewer.review({
    userId: 'other-user',
    entry: makeEntry('other-abuse', '你这个蠢货'),
    now: 50_001
  }).blocked, false);
  assertDecision(reviewer.review({
    userId: 'global-user',
    entry: makeEntry('group-abuse', '毛毛你真是废物'),
    now: 50_002
  }), {
    blocked: true,
    reasonCode: 'repeated_abuse',
    severity: 'medium',
    windowSize: 2
  });

  reviewer.reset();
  assertDecision(reviewer.review({
    userId: 'global-user',
    entry: makeEntry('after-reset', '你这个白痴'),
    now: 50_003
  }), {
    blocked: false,
    reasonCode: 'repeated_abuse',
    severity: 'low',
    windowSize: 1
  });
}

async function testExpiredAndOverflowUserWindowsAreReclaimed() {
  const reviewer = createInboundUserSafetyReviewer({ maxTrackedUsers: 64 });
  for (let index = 0; index < 50; index += 1) {
    reviewer.review({
      userId: `expired-user-${index}`,
      entry: makeEntry(`expired-first-${index}`, '你这个白痴'),
      now: 55_000
    });
  }
  reviewer.review({
    userId: 'fresh-user',
    entry: makeEntry('fresh-message', '普通消息'),
    now: 55_000 + WINDOW_MS + 1
  });
  assertDecision(reviewer.review({
    userId: 'expired-user-0',
    entry: makeEntry('expired-second', '瑞希你这个蠢货'),
    now: 55_000 + WINDOW_MS + 2
  }), {
    blocked: false,
    reasonCode: 'repeated_abuse',
    severity: 'low',
    windowSize: 1
  });

  const limitedReviewer = createInboundUserSafetyReviewer({ maxTrackedUsers: 2 });
  limitedReviewer.review({
    userId: 'oldest-user',
    entry: makeEntry('oldest-first', '你这个白痴'),
    now: 56_000
  });
  limitedReviewer.review({
    userId: 'second-user',
    entry: makeEntry('second-clean', '普通消息'),
    now: 56_001
  });
  limitedReviewer.review({
    userId: 'third-user',
    entry: makeEntry('third-clean', '普通消息'),
    now: 56_002
  });
  assertDecision(limitedReviewer.review({
    userId: 'oldest-user',
    entry: makeEntry('oldest-second', '瑞希你这个蠢货'),
    now: 56_003
  }), {
    blocked: false,
    reasonCode: 'repeated_abuse',
    severity: 'low',
    windowSize: 1
  });
}

async function testCleanAndImageOnlyMessagesReturnStableDecisionShape() {
  const reviewer = createInboundUserSafetyReviewer();
  assertDecision(reviewer.review({
    userId: 'clean-user',
    entry: makeEntry('clean-1', '', {
      imageUrls: ['https://example.com/political-image.png'],
      replyContext: { text: '' },
      forwardSummaryText: ''
    }),
    now: 60_000
  }), {
    blocked: false,
    reasonCode: '',
    severity: 'none',
    windowSize: 1
  });

  reviewer.reset();
  assertDecision(reviewer.review({
    userId: 'clean-user',
    entry: makeEntry('clean-target-word', '你知道垃圾分类怎么做吗'),
    now: 60_001
  }), {
    blocked: false,
    reasonCode: '',
    severity: 'none',
    windowSize: 1
  });

  reviewer.reset();
  assertDecision(reviewer.review({
    userId: 'clean-compound-user',
    entry: makeEntry('clean-compound-1', '你这个垃圾分类方案不错'),
    now: 60_002
  }), {
    blocked: false,
    reasonCode: '',
    severity: 'none',
    windowSize: 1
  });
  assertDecision(reviewer.review({
    userId: 'clean-compound-user',
    entry: makeEntry('clean-compound-2', '机器人垃圾回收功能怎么用'),
    now: 60_003
  }), {
    blocked: false,
    reasonCode: '',
    severity: 'none',
    windowSize: 2
  });
  assertDecision(reviewer.review({
    userId: 'clean-compound-user',
    entry: makeEntry('clean-compound-3', '你这个垃圾的分类方式是什么'),
    now: 60_004
  }), {
    blocked: false,
    reasonCode: '',
    severity: 'none',
    windowSize: 3
  });
  assertDecision(reviewer.review({
    userId: 'clean-compound-user',
    entry: makeEntry('clean-compound-4', '机器人垃圾相关的回收功能怎么用'),
    now: 60_005
  }), {
    blocked: false,
    reasonCode: '',
    severity: 'none',
    windowSize: 4
  });
}

(async () => {
  await testExports();
  await testPrepareEntryAndConversationDetection();
  await testPrepareEntryResolvesForwardAndKeepsCurrentTextOnFailure();
  await testPoliticalReviewUsesAllTextSourcesAndPrecedesOtherRules();
  await testMaliciousReviewUsesExistingDetectors();
  await testDirectedViolenceAndNonDirectedExemptions();
  await testViolenceAndSexualContextBoundaries();
  await testDirectedSexualHarassmentAndExemptions();
  await testRepeatedAbuseNeedsTwoDifferentMessages();
  await testRepeatedAbuseDedupesMessageIdsAndExpires();
  await testRepeatedAbuseDedupesAfterMessageWindowEviction();
  await testRepeatedAbuseDedupesForFullWindowLifetime();
  await testMessageExpiryIsExactPerUser();
  await testWindowKeepsOnlyFiveReviewedMessages();
  await testWindowIsGlobalPerUserAndIsolatedBetweenUsers();
  await testExpiredAndOverflowUserWindowsAreReclaimed();
  await testCleanAndImageOnlyMessagesReturnStableDecisionShape();
  console.log('inboundUserSafety.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

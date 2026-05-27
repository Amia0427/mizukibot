const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.GROUP_SUMMARY_DEFAULT_LIMIT = '200';
process.env.GROUP_SUMMARY_MAX_LIMIT = '500';
process.env.GROUP_SUMMARY_MODEL_MAX_CHARS = '12000';

const {
  buildGroupSummaryModelConfig,
  buildStats,
  cleanMessageText,
  generateGroupSummary,
  normalizeHistoryMessage,
  parseGroupSummaryLimit
} = require('../api/groupSummaryService');

module.exports = (async () => {
  assert.strictEqual(parseGroupSummaryLimit({ payload: '' }, {
    GROUP_SUMMARY_DEFAULT_LIMIT: 200,
    GROUP_SUMMARY_MAX_LIMIT: 500
  }), 200);
  assert.strictEqual(parseGroupSummaryLimit({ payload: '50' }, {
    GROUP_SUMMARY_DEFAULT_LIMIT: 200,
    GROUP_SUMMARY_MAX_LIMIT: 500
  }), 50);
  assert.strictEqual(parseGroupSummaryLimit({ payload: '9999' }, {
    GROUP_SUMMARY_DEFAULT_LIMIT: 200,
    GROUP_SUMMARY_MAX_LIMIT: 500
  }), 500);

  assert.deepStrictEqual(buildGroupSummaryModelConfig({
    GROUP_SUMMARY_MODEL: 'summary-model',
    GROUP_SUMMARY_API_BASE_URL: 'https://summary.example/v1/chat/completions',
    GROUP_SUMMARY_API_KEY: 'summary-key',
    GROUP_SUMMARY_MODEL_TYPE: 'openai_compatible'
  }), {
    model: 'summary-model',
    apiBaseUrl: 'https://summary.example/v1/chat/completions',
    apiKey: 'summary-key',
    provider: 'openai_compatible'
  });
  assert.strictEqual(buildGroupSummaryModelConfig({}), null);

  assert.strictEqual(
    cleanMessageText('[CQ:reply,id=1][CQ:at,qq=2] 你好 [CQ:image,url=x] [CQ:face,id=1]'),
    '你好 [图片] [表情]'
  );

  const normalized = normalizeHistoryMessage({
    user_id: 'u1',
    time: 1710000000,
    raw_message: '[CQ:at,qq=bot] 今天聊部署 [CQ:image,url=x]',
    sender: { card: '小明' },
    message_id: 'm1'
  }, { botQQ: 'bot' });
  assert.strictEqual(normalized.userId, 'u1');
  assert.strictEqual(normalized.senderName, '小明');
  assert.strictEqual(normalized.text, '今天聊部署 [图片]');

  const stats = buildStats([
    normalized,
    normalizeHistoryMessage({
      user_id: 'u2',
      time: 1710000600,
      raw_message: '我觉得可以先灰度 [CQ:face,id=14]',
      sender: { nickname: '小红' }
    }, { botQQ: 'bot' })
  ]);
  assert.strictEqual(stats.totalMessages, 2);
  assert.strictEqual(stats.participantCount, 2);
  assert.strictEqual(stats.imageCount, 1);
  assert.strictEqual(stats.emojiCount, 1);

  const calls = [];
  const summaryResult = await generateGroupSummary({
    groupId: 'g1',
    userId: 'admin',
    botQQ: 'bot',
    command: { payload: '50' }
  }, {
    config: {
      BOT_QQ: 'bot',
      GROUP_SUMMARY_DEFAULT_LIMIT: 200,
      GROUP_SUMMARY_MAX_LIMIT: 500,
      GROUP_SUMMARY_MODEL_MAX_CHARS: 12000,
      GROUP_SUMMARY_MODEL: 'summary-model',
      GROUP_SUMMARY_API_BASE_URL: 'https://summary.example/v1/chat/completions',
      GROUP_SUMMARY_API_KEY: 'summary-key',
      GROUP_SUMMARY_MODEL_TYPE: 'openai_compatible'
    },
    getGroupMessageHistoryCached: async (groupId, options) => {
      calls.push({ groupId, options });
      return [
        { user_id: 'u1', time: 1710000000, raw_message: '今天先上线灰度', sender: { card: '小明' } },
        { user_id: 'bot', time: 1710000001, raw_message: '机器人消息', sender: { nickname: 'bot' } },
        { user_id: 'u2', time: 1710000060, raw_message: '同意，先看日志', sender: { nickname: '小红' } }
      ];
    },
    requestNonStreamingReply: async (messages, context) => {
      assert.ok(Array.isArray(messages));
      assert.ok(String(messages[1].content).includes('今天先上线灰度'));
      assert.strictEqual(context.routePolicyKey, 'admin/group_summary');
      assert.deepStrictEqual(context.modelConfig, {
        model: 'summary-model',
        apiBaseUrl: 'https://summary.example/v1/chat/completions',
        apiKey: 'summary-key',
        provider: 'openai_compatible'
      });
      return { visibleText: '群总结正文' };
    }
  });
  assert.strictEqual(summaryResult.ok, true);
  assert.strictEqual(summaryResult.text, '群总结正文');
  assert.strictEqual(summaryResult.sampledMessages, 2);
  assert.strictEqual(calls[0].options.count, 50);

  const emptyResult = await generateGroupSummary({
    groupId: 'g1',
    userId: 'admin',
    botQQ: 'bot',
    command: {}
  }, {
    config: {
      BOT_QQ: 'bot',
      GROUP_SUMMARY_DEFAULT_LIMIT: 200,
      GROUP_SUMMARY_MAX_LIMIT: 500,
      GROUP_SUMMARY_MODEL_MAX_CHARS: 12000
    },
    getGroupMessageHistoryCached: async () => []
  });
  assert.strictEqual(emptyResult.ok, false);
  assert.strictEqual(emptyResult.reason, 'empty_history');

  const failedResult = await generateGroupSummary({
    groupId: 'g1',
    userId: 'admin',
    botQQ: 'bot',
    command: {}
  }, {
    config: {
      BOT_QQ: 'bot',
      GROUP_SUMMARY_DEFAULT_LIMIT: 200,
      GROUP_SUMMARY_MAX_LIMIT: 500,
      GROUP_SUMMARY_MODEL_MAX_CHARS: 12000
    },
    getGroupMessageHistoryCached: async () => {
      throw new Error('api down');
    }
  });
  assert.strictEqual(failedResult.ok, false);
  assert.strictEqual(failedResult.reason, 'history_failed');
  assert.ok(failedResult.text.includes('api down'));

  const modelFallback = await generateGroupSummary({
    groupId: 'g1',
    userId: 'admin',
    botQQ: 'bot',
    command: {}
  }, {
    config: {
      BOT_QQ: 'bot',
      GROUP_SUMMARY_DEFAULT_LIMIT: 200,
      GROUP_SUMMARY_MAX_LIMIT: 500,
      GROUP_SUMMARY_MODEL_MAX_CHARS: 12000
    },
    getGroupMessageHistoryCached: async () => [
      { user_id: 'u1', time: 1710000000, raw_message: '今天聊部署', sender: { card: '小明' } }
    ],
    requestNonStreamingReply: async () => {
      throw new Error('model down');
    }
  });
  assert.strictEqual(modelFallback.ok, true);
  assert.strictEqual(modelFallback.modelFailed, true);
  assert.ok(modelFallback.text.includes('基础统计'));

  console.log('groupSummaryService.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

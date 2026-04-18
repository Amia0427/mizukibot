const assert = require('assert');

const { buildLlmPerception } = require('../core/llmPerception');

(() => {
  const privateResult = buildLlmPerception({
    chatType: 'private',
    senderName: 'Alice',
    messageMeta: {
      senderName: 'Alice'
    },
    rawText: '你好'
  }, {
    enabled: true,
    enablePlatform: true,
    enableHoliday: false,
    enableSessionTiming: false,
    enableConversationAtmosphere: false,
    enableLunar: false,
    enableSolarTerm: false,
    enableAlmanac: false
  });

  assert.ok(privateResult.text.includes('当前发送者：Alice'));

  const groupResult = buildLlmPerception({
    chatType: 'group',
    effectiveMsg: {
      group_name: '测试群',
      sender: {
        card: '群名片',
        nickname: 'QQ昵称'
      }
    },
    messageMeta: {
      senderName: '群名片',
      groupName: '测试群'
    },
    rawText: '你好'
  }, {
    enabled: true,
    enablePlatform: true,
    enableHoliday: false,
    enableSessionTiming: false,
    enableConversationAtmosphere: false,
    enableLunar: false,
    enableSolarTerm: false,
    enableAlmanac: false
  });

  assert.ok(groupResult.text.includes('当前发送者：群名片'));
  assert.ok(!groupResult.text.includes('当前发送者：QQ昵称'));

  console.log('llmPerceptionSenderName.test.js passed');
})();

const assert = require('assert');

const {
  buildDirectedContextPromptSnippet
} = require('../api/runtimeV2/context/service');
const {
  resolveMessageDirectedContext
} = require('../core/messageDirectedContext');

module.exports = (async () => {
  const forwardSummaryText = [
    'Alice: 敏感日期那个笑话我看懂了',
    'Bob: 后面突然跳到个人卫生',
    'Carol: 又跳到童年经历',
    'Mizuki: 全部杀死算了'
  ].join('\n');
  const cleanText = [
    '[转发消息]',
    forwardSummaryText,
    '你当时在说什么？是对那些转发内容的反应吗？'
  ].join('\n');

  const directedContext = await resolveMessageDirectedContext({
    senderId: 'same_user',
    botQQ: 'bot_test',
    chatType: 'private',
    rawText: cleanText,
    cleanText,
    isAtBot: true,
    continuousMeta: {
      forwardIds: ['fw_context_1'],
      forwardSummaryText,
      forwardImageUrls: ['https://example.com/forward.png']
    }
  });

  assert.ok(directedContext.forwardContext, 'forward context should be captured');
  assert.strictEqual(directedContext.signals.hasForwardContext, true);
  assert.ok(directedContext.forwardContext.summaryText.includes('全部杀死算了'));
  assert.ok(directedContext.forwardContext.summaryText.includes('个人卫生'));
  assert.strictEqual(directedContext.forwardContext.imageCount, 1);
  assert.ok(
    directedContext.promptSnippet.includes('forwarded_message_text='),
    'directed prompt snippet should include forwarded text'
  );
  assert.ok(
    directedContext.promptSnippet.includes('current turn as visible conversation context'),
    'directed prompt snippet should tell the model this is current visible context'
  );

  const runtimePrompt = buildDirectedContextPromptSnippet(directedContext);
  assert.ok(runtimePrompt.includes('[CurrentConversation]'));
  assert.ok(runtimePrompt.includes('forward_context_source=current_message_forward'));
  assert.ok(runtimePrompt.includes('全部杀死算了'));
  assert.ok(runtimePrompt.includes('check forwarded_message_text before saying the prior context is unknown'));

  console.log('messageDirectedForwardContext.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

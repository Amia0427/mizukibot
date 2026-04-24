const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { mapMessagesToAnthropic } = require('../api/httpClient');

module.exports = (async () => {
  const contextService = fs.readFileSync(path.join(__dirname, '..', 'api/runtimeV2/context/service.js'), 'utf8');
  const researchBlockMatch = contextService.match(/createPromptBlock\('background_research'[\s\S]*?priority:\s*(\d+)/);
  const memoryBlockMatch = contextService.match(/createPromptBlock\('retrieved_memory_lite'[\s\S]*?priority:\s*(\d+)/);
  assert.ok(researchBlockMatch, 'background research prompt block should exist');
  assert.ok(memoryBlockMatch, 'retrieved memory prompt block should exist');
  assert.ok(
    Number(memoryBlockMatch[1]) < Number(researchBlockMatch[1]),
    'retrieved memory should have higher prompt priority than background research'
  );

  const host = fs.readFileSync(path.join(__dirname, '..', 'api/runtimeV2/host.js'), 'utf8');
  const liveFnMatch = host.match(/function buildLiveMainConversationSnapshot[\s\S]*?function normalizeMessageForToolLoop/);
  assert.ok(liveFnMatch, 'buildLiveMainConversationSnapshot should exist');
  assert.ok(
    liveFnMatch[0].includes('buildAssistantOnlyContextMessages(state)'),
    'live main context should keep assistant-only context before user turn'
  );

  const mapped = await mapMessagesToAnthropic([
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: '[Context for assistant only]\nfew-shot tone hint' },
    { role: 'user', content: 'remember what I like?' }
  ]);
  const roles = mapped.messages.map((message) => message.role);
  assert.deepStrictEqual(roles.slice(-2), ['assistant', 'user']);

  console.log('mainContextMemoryRegression.test.js passed');
})();
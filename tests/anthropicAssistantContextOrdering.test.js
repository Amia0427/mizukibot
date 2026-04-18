const assert = require('assert');

const { mapMessagesToAnthropic } = require('../api/httpClient');

module.exports = (async () => {
  const mapped = await mapMessagesToAnthropic([
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: '[Context for assistant only]\nturn-local hint' },
    { role: 'user', content: 'hello' }
  ]);

  assert.ok(Array.isArray(mapped.messages));
  assert.ok(mapped.messages.length >= 2);
  const lastMessage = mapped.messages[mapped.messages.length - 1];
  assert.strictEqual(lastMessage.role, 'user');
  const assistantContextIndex = mapped.messages.findIndex((item) => item.role === 'assistant');
  const lastUserIndex = mapped.messages.map((item) => item.role).lastIndexOf('user');
  assert.ok(assistantContextIndex >= 0);
  assert.ok(assistantContextIndex < lastUserIndex);

  console.log('anthropicAssistantContextOrdering.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

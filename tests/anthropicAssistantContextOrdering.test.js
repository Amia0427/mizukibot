const assert = require('assert');

const { mapMessagesToAnthropic } = require('../api/httpClient');

function assertNoEmptyTextBlocks(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoEmptyTextBlocks(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'text') {
    assert.notStrictEqual(String(value.text || ''), '');
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') assertNoEmptyTextBlocks(child);
  }
}

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

  const emptyMapped = await mapMessagesToAnthropic([
    { role: 'assistant', content: [{ type: 'text', text: '' }] },
    { role: 'user', content: '' },
    { role: 'user', content: [{ type: 'text', text: '   ' }] }
  ]);
  assert.deepStrictEqual(emptyMapped.messages, [
    { role: 'user', content: [{ type: 'text', text: '(empty input)' }] }
  ]);
  assertNoEmptyTextBlocks(emptyMapped);

  const mixedMapped = await mapMessagesToAnthropic([
    { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: 'hello' }] }
  ]);
  assert.deepStrictEqual(mixedMapped.messages, [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] }
  ]);
  assertNoEmptyTextBlocks(mixedMapped);

  console.log('anthropicAssistantContextOrdering.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

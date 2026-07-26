const assert = require('assert');
const { mapMessagesToAnthropic } = require('../src/model/http/request-shaping.chunk');

module.exports = (async () => {
  const rawToolCallId = 'read_shared_link_1_shared-link:song:186016_1753500000000';
  const mapped = await mapMessagesToAnthropic([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: rawToolCallId,
        type: 'function',
        function: {
          name: 'read_shared_link',
          arguments: '{"url":"https://music.163.com/song?id=186016"}'
        }
      }]
    },
    {
      role: 'tool',
      tool_call_id: rawToolCallId,
      content: 'platform: netease'
    }
  ]);

  const toolUseId = mapped.messages[0].content[0].id;
  const toolResultId = mapped.messages[1].content[0].tool_use_id;

  assert.match(toolUseId, /^[a-zA-Z0-9_-]+$/);
  assert.notStrictEqual(toolUseId, rawToolCallId);
  assert.strictEqual(toolResultId, toolUseId);

  const validMapped = await mapMessagesToAnthropic([{
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'call_valid-1',
      type: 'function',
      function: { name: 'read_shared_link', arguments: '{}' }
    }]
  }]);
  assert.strictEqual(validMapped.messages[0].content[0].id, 'call_valid-1');
})();

const assert = require('assert');

const { extractMessageContent, extractSSEEvents } = require('../api/parser');
const { normalizeTextContent } = require('../api/runtimeV2/model/shared');

module.exports = (() => {
  const responsesOutputText = extractMessageContent({
    data: {
      output_text: 'ok from output_text'
    }
  });
  assert.deepStrictEqual(responsesOutputText, {
    role: 'assistant',
    content: 'ok from output_text'
  });

  const responsesOutputArray = extractMessageContent({
    data: {
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'hello ' },
            { type: 'output_text', text: 'world' }
          ]
        }
      ]
    }
  });
  assert.deepStrictEqual(responsesOutputArray, {
    role: 'assistant',
    content: 'hello world'
  });

  const directContent = extractMessageContent({
    data: {
      content: [
        { type: 'text', text: 'direct ' },
        { type: 'text', content: 'content' }
      ]
    }
  });
  assert.deepStrictEqual(directContent, {
    role: 'assistant',
    content: 'direct content'
  });

  const plainText = extractMessageContent({
    data: 'plain text from proxy'
  });
  assert.deepStrictEqual(plainText, {
    role: 'assistant',
    content: 'plain text from proxy'
  });

  const legacyChoiceText = extractMessageContent({
    data: {
      choices: [
        { text: 'legacy completion text' }
      ]
    }
  });
  assert.deepStrictEqual(legacyChoiceText, {
    role: 'assistant',
    content: 'legacy completion text'
  });

  const nestedProxyResponse = extractMessageContent({
    data: {
      result: {
        response: {
          output: [
            {
              content: [
                { text: 'nested proxy text' }
              ]
            }
          ]
        }
      }
    }
  });
  assert.deepStrictEqual(nestedProxyResponse, {
    role: 'assistant',
    content: 'nested proxy text'
  });

  const objectContentMessage = extractMessageContent({
    data: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: { type: 'text', text: 'object content text' }
          }
        }
      ]
    }
  });
  assert.deepStrictEqual(objectContentMessage, {
    role: 'assistant',
    content: 'object content text'
  });
  const geminiText = extractMessageContent({
    data: {
      candidates: [
        {
          content: {
            parts: [
              { text: 'gemini ok' }
            ]
          }
        }
      ]
    }
  });
  assert.deepStrictEqual(geminiText, {
    role: 'assistant',
    content: 'gemini ok'
  });
  const geminiFunctionCall = extractMessageContent({
    data: {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'lookup',
                  args: { q: 'x' }
                }
              }
            ]
          }
        }
      ]
    }
  });
  assert.strictEqual(geminiFunctionCall.role, 'assistant');
  assert.strictEqual(geminiFunctionCall.content, '');
  assert.strictEqual(geminiFunctionCall.tool_calls[0].type, 'function');
  assert.strictEqual(geminiFunctionCall.tool_calls[0].function.name, 'lookup');
  assert.strictEqual(geminiFunctionCall.tool_calls[0].function.arguments, JSON.stringify({ q: 'x' }));
  assert.notStrictEqual(String(objectContentMessage.content), '[object Object]');
  assert.strictEqual(
    normalizeTextContent({ type: 'text', text: 'shared object content' }),
    'shared object content'
  );
  assert.strictEqual(
    normalizeTextContent([{ type: 'text', content: { output_text: 'nested shared content' } }]),
    'nested shared content'
  );
  assert.strictEqual(
    normalizeTextContent({ visibleText: 'visible runtime reply', persistedText: 'persisted runtime reply' }),
    'persisted runtime reply'
  );
  assert.strictEqual(
    normalizeTextContent({ finalReply: 'final runtime reply' }),
    'final runtime reply'
  );

  const geminiStreamState = { buffer: '' };
  const geminiStream = extractSSEEvents(
    geminiStreamState,
    'data: {"candidates":[{"content":{"parts":[{"text":"首字"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2,"totalTokenCount":9,"cachedContentTokenCount":3}}\n\n'
  );
  assert.strictEqual(geminiStream.events.length, 1);
  assert.strictEqual(geminiStream.events[0].delta, '首字');
  assert.strictEqual(geminiStream.events[0].usage.prompt_tokens, 7);
  assert.strictEqual(geminiStream.events[0].usage.completion_tokens, 2);
  assert.strictEqual(geminiStream.events[0].usage.total_tokens, 9);
  assert.strictEqual(geminiStream.events[0].usage.cache_read_input_tokens, 3);

  console.log('parserModelResponseFormats.test.js passed');
})()

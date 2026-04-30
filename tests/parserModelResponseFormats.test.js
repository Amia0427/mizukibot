const assert = require('assert');

const { extractMessageContent } = require('../api/parser');
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

  console.log('parserModelResponseFormats.test.js passed');
})()

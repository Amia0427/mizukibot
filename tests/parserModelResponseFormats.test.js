const assert = require('assert');

const { extractMessageContent } = require('../api/parser');

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

  console.log('parserModelResponseFormats.test.js passed');
})()

// Static tool schemas split from api/toolSchemas.js.
const batch2ToolSchemas = [
  {
    type: 'function',
    function: {
      name: 'url_safety_check',
      description: '妫€鏌?URL 椋庨櫓',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'json_validate',
      description: 'Validate JSON and provide fix suggestions',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'study_card_generator',
      description: '鐢熸垚瀛︿範鍗＄墖',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          points: { type: 'string' },
          count: { type: 'number' }
        },
        required: ['topic']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'meeting_minutes_struct',
      description: 'Structure meeting notes',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      }
    }
  }
];

module.exports = { batch2ToolSchemas };

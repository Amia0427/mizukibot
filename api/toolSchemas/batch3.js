// Static tool schemas split from api/toolSchemas.js.
const batch3ToolSchemas = [
  {
    type: 'function',
    function: {
      name: 'extract_todo_from_text',
      description: 'Extract TODO items from text',
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
      name: 'pomodoro_plan',
      description: 'Generate a pomodoro plan',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          total_minutes: { type: 'number' },
          focus_minutes: { type: 'number' },
          break_minutes: { type: 'number' }
        },
        required: ['goal']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'regex_tester',
      description: 'Test regular expressions',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          text: { type: 'string' },
          flags: { type: 'string' }
        },
        required: ['pattern', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'text_stats',
      description: 'Text statistics',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          top_n: { type: 'number' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'safe_eval_math',
      description: 'Safely evaluate math expressions',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression']
      }
    }
  }
];

module.exports = { batch3ToolSchemas };

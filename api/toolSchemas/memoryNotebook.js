// Static tool schemas split from api/toolSchemas.js.
const memoryNotebookToolSchemas = [
  {
    type: 'function',
    function: {
      name: 'notebook_reindex_folder',
      description: 'Reindex local notebook knowledge base',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          folderPath: { type: 'string' },
          options: { type: 'object' }
        },
        required: ['userId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notebook_add_document',
      description: '鍚戞湰鍦扮煡璇嗗簱鏂板鏂囨。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['userId', 'title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notebook_list_docs',
      description: 'List notebook documents',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'string' } },
        required: ['userId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notebook_search',
      description: '搜索知识库片段',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          query: { type: 'string' },
          top_k: { type: 'number' }
        },
        required: ['userId', 'query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_cli',
      description: 'Read-only virtual CLI for long-term memory lookup. The command field must contain only a bare command string, not JSON, not code fences, and not explanatory text. Valid chat examples: `mem search --query "likes"`; `mem open --ref "mc_ref:..."`; `mem open --source profile`; `mem open --source personal --id "..."`. In normal chat do not use `mem ls` or `mem stats`.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'A single bare memory_cli command string only. Do not include `command:` prefixes, JSON wrappers, markdown code fences, or natural-language explanation. Prefer `mem search --query "..."` first, then `mem open --ref "..."` if needed.'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_context_stats',
      description: 'Inspect the effective context prepared for the main conversation model in the current turn. Use this when the user asks about current context usage, remaining context, token usage, or whether the chat is close to the context limit.',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            description: 'Optional output format. Leave empty or use "text".'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'self_improvement_recent',
      description: 'Read recent self-improvement events. Admin-only read surface.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          kind: { type: 'string' },
          status: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'self_improvement_search',
      description: 'Search self-improvement events. Admin-only read surface.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          top_k: { type: 'number' },
          kind: { type: 'string' },
          promoted_only: { type: 'boolean' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'self_improvement_patterns',
      description: 'Read aggregated self-improvement patterns. Admin-only read surface.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          route_policy_key: { type: 'string' },
          tool_name: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'self_improvement_rules',
      description: 'Read promoted self-improvement runtime rules. Admin-only read surface.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          pattern_key: { type: 'string' },
          top_route_type: { type: 'string' },
          tool_name: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'self_improvement_guides',
      description: 'Read promoted self-improvement local guides. Admin-only read surface.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          pattern_key: { type: 'string' },
          active_only: { type: 'boolean' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notebook_append_journal',
      description: '杩藉姞鏃ヨ',
      parameters: {
        type: 'object',
        properties: {
          entry: { type: 'string' },
          tag: { type: 'string' }
        },
        required: ['entry']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notebook_read_recent_journal',
      description: 'Read recent journal entries',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number' }
        }
      }
    }
  }
];

module.exports = { memoryNotebookToolSchemas };

const assert = require('assert');

const { executeStep } = require('../api/runtimeV2/capabilities/scheduler');

module.exports = (async () => {
  const envelope = await executeStep({
    id: 'step_1',
    tool: 'web_fetch',
    inputs: { url: 'https://platform.openai.com/docs' }
  }, {
    request: {
      allowedTools: ['web_fetch'],
      userId: 'u1',
      routeMeta: {}
    },
    execution: {}
  }, {
    node: 'dispatch',
    registry: {
      byName: new Map([[
        'web_fetch',
        {
          name: 'web_fetch',
          executor: async () => '页面提取失败：ERR_BAD_REQUEST',
          parallelSafe: false
        }
      ]]),
      descriptors: []
    },
    executors: {
      web_fetch: async () => '页面提取失败：ERR_BAD_REQUEST'
    },
    helpers: {
      enforceToolPolicy(_toolName, args) {
        return args;
      }
    }
  });

  assert.strictEqual(envelope.status, 'failed');
  assert.strictEqual(envelope.retryable, true);

  const unresolvedMemoryOpen = await executeStep({
    id: 'step_mem_open',
    tool: 'memory_cli',
    inputs: { command: 'mem open --ref "<to_be_resolved_from_search>"' }
  }, {
    request: {
      allowedTools: ['memory_cli'],
      userId: 'u1',
      routeMeta: {}
    },
    execution: {
      memoryCliTurn: {
        searchCount: 0,
        openCount: 0,
        successfulCount: 0,
        mustAnswer: false,
        lastSuccessCommand: '',
        lastResultHadHits: false,
        lastErrorType: 'none'
      },
      toolResults: []
    },
    plan: {
      steps: []
    }
  }, {
    node: 'dispatch',
    registry: {
      byName: new Map([[ 'memory_cli', { name: 'memory_cli', executor: async () => '{"ok":true}', parallelSafe: false } ]]),
      descriptors: []
    },
    executors: {
      memory_cli: async () => '{"ok":true}'
    },
    helpers: {
      enforceToolPolicy(_toolName, args) {
        return args;
      }
    }
  });

  assert.strictEqual(unresolvedMemoryOpen.status, 'blocked');
  assert.strictEqual(unresolvedMemoryOpen.retryable, false);
  assert.strictEqual(unresolvedMemoryOpen.blockedReason, 'runtime_binding_unresolved:memory_ref');

  const previousSearchResult = JSON.stringify({
    ok: true,
    command: 'search',
    count: 1,
    results: [{ ref: 'mc_ref:personal:abc', preview: '喜欢猫' }]
  });
  const reusedSearch = await executeStep({
    id: 'step_mem_search_2',
    tool: 'memory_cli',
    inputs: { command: 'mem search --query "喜欢什么"' }
  }, {
    request: {
      allowedTools: ['memory_cli'],
      userId: 'u1',
      routeMeta: {}
    },
    execution: {
      memoryCliTurn: {
        searchCount: 1,
        openCount: 0,
        successfulCount: 1,
        mustAnswer: false,
        lastSuccessCommand: 'search',
        lastResultHadHits: true,
        lastErrorType: 'none'
      },
      toolResults: [{
        tool_name: 'memory_cli',
        result: previousSearchResult
      }]
    },
    plan: {
      steps: []
    }
  }, {
    node: 'dispatch',
    registry: {
      byName: new Map([[ 'memory_cli', { name: 'memory_cli', executor: async () => '{"ok":false}', parallelSafe: false } ]]),
      descriptors: []
    },
    executors: {
      memory_cli: async () => '{"ok":false}'
    },
    helpers: {
      enforceToolPolicy(_toolName, args) {
        return args;
      }
    }
  });

  assert.strictEqual(reusedSearch.status, 'completed');
  assert.strictEqual(reusedSearch.retryable, false);
  assert.strictEqual(reusedSearch.result, previousSearchResult);
  console.log('toolFailureDetection.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

const assert = require('assert');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

module.exports = (async () => {
  clearProjectCache();
  const runtimePath = require.resolve('../api/mcpRuntime');
  require.cache[runtimePath] = {
    id: runtimePath,
    filename: runtimePath,
    loaded: true,
    exports: {
      discoverMcpTools: async () => [
        { serverName: 'memos-api-mcp', toolName: 'search_memory' },
        { serverName: 'memos-api-mcp', toolName: 'add_message' }
      ],
      callMcpTool: async (serverName, toolName, args) => {
        assert.strictEqual(serverName, 'memos-api-mcp');
        assert.strictEqual(toolName, 'search_memory');
        assert.strictEqual(args.user_id, 'user-123');
        assert.strictEqual(args.channel, 'MODELSCOPE');
        return {
          result: {
            memories: [
              { id: 'm1', text: '用户偏好先给结论，再补关键细节。', score: 0.91, created_at: '2026-05-18' },
              { id: 'm2', content: '用户正在并行开发，不能覆盖其他人的改动。', score: 0.83 }
            ]
          }
        };
      }
    }
  };

  const memos = require('../utils/memosPlannerRecall');
  const recall = await memos.recallForPlanner('继续刚才的实现', {
    config: {
      MEMOS_MCP_ENABLED: true,
      MEMOS_MCP_SERVER_NAME: 'memos-api-mcp',
      MEMOS_RECALL_TOP_K: 2,
      MEMOS_RECALL_MAX_CHARS: 500,
      MEMOS_RECALL_TIMEOUT_MS: 500,
      MEMOS_USER_ID: 'user-123',
      MEMOS_CHANNEL: 'MODELSCOPE'
    }
  });

  assert.strictEqual(recall.used, true);
  assert.strictEqual(recall.items.length, 2);
  assert.ok(recall.promptText.startsWith('[MemOSRecall]'));
  assert.ok(recall.promptText.includes('先给结论'));
  assert.strictEqual(recall.diagnostics.searchToolName, 'search_memory');

  const empty = await memos.recallForPlanner('不会调用', {
    config: {
      MEMOS_MCP_ENABLED: false
    }
  });
  assert.strictEqual(empty.used, false);
  assert.strictEqual(empty.rejectedReason, 'disabled');

  console.log('memosPlannerRecall.test.js passed');
  clearProjectCache();
})().catch((error) => {
  clearProjectCache();
  console.error(error);
  process.exit(1);
});

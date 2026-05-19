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
        { serverName: 'memos-api-mcp', toolName: 'get_kb_documents' },
        { serverName: 'memos-api-mcp', toolName: 'search_memory' },
        { serverName: 'memos-api-mcp', toolName: 'add_message' }
      ],
      discoverMcpServerTools: async (serverName) => {
        assert.strictEqual(serverName, 'memos-api-mcp');
        return [
          { serverName: 'memos-api-mcp', toolName: 'get_kb_documents' },
          { serverName: 'memos-api-mcp', toolName: 'search_memory' },
          { serverName: 'memos-api-mcp', toolName: 'add_message' }
        ];
      },
      callMcpTool: async (serverName, toolName, args) => {
        assert.strictEqual(serverName, 'memos-api-mcp');
        assert.strictEqual(toolName, 'get_kb_documents');
        assert.notStrictEqual(toolName, 'add_message');
        assert.deepStrictEqual(args.file_ids, ['kb-file-1', 'kb-file-2']);
        return {
          result: {
            files: [
              { file_id: 'kb-file-1', file_name: '偏好.md', content: '用户偏好先给结论，再补关键细节。' },
              { file_id: 'kb-file-2', file_name: '协作.md', document_text: '用户正在并行开发，不能覆盖其他人的改动。' }
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
      MEMOS_CHANNEL: 'MODELSCOPE',
      MEMOS_RECALL_SOURCE: 'knowledge_base',
      MEMOS_KB_FILE_IDS: ['kb-file-1', 'kb-file-2']
    }
  });

  assert.strictEqual(recall.used, true);
  assert.strictEqual(recall.items.length, 2);
  assert.ok(recall.promptText.startsWith('[MemOSRecall]'));
  assert.ok(recall.promptText.includes('先给结论'));
  assert.strictEqual(recall.diagnostics.recallSource, 'knowledge_base');
  assert.strictEqual(recall.diagnostics.kbToolName, 'get_kb_documents');
  assert.strictEqual(recall.diagnostics.sourceToolName, 'get_kb_documents');
  assert.strictEqual(recall.diagnostics.readOnly, true);

  const missingKbIds = await memos.recallForPlanner('没有配置 kb 文件', {
    config: {
      MEMOS_MCP_ENABLED: true,
      MEMOS_MCP_SERVER_NAME: 'memos-api-mcp',
      MEMOS_RECALL_SOURCE: 'knowledge_base',
      MEMOS_KB_FILE_IDS: []
    }
  });
  assert.strictEqual(missingKbIds.used, false);
  assert.strictEqual(missingKbIds.rejectedReason, 'kb_file_ids_missing');

  clearProjectCache();
  require.cache[runtimePath] = {
    id: runtimePath,
    filename: runtimePath,
    loaded: true,
    exports: {
      discoverMcpTools: async () => [{ serverName: 'memos-api-mcp', toolName: 'search_memory' }],
      discoverMcpServerTools: async () => [{ serverName: 'memos-api-mcp', toolName: 'search_memory' }],
      callMcpTool: async () => {
        throw new Error('KB recall should not call MCP when get_kb_documents is unavailable');
      }
    }
  };
  const memosWithoutKbTool = require('../utils/memosPlannerRecall');
  const missingKbTool = await memosWithoutKbTool.recallForPlanner('工具缺失', {
    config: {
      MEMOS_MCP_ENABLED: true,
      MEMOS_MCP_SERVER_NAME: 'memos-api-mcp',
      MEMOS_RECALL_SOURCE: 'knowledge_base',
      MEMOS_KB_FILE_IDS: ['kb-file-1']
    }
  });
  assert.strictEqual(missingKbTool.used, false);
  assert.strictEqual(missingKbTool.rejectedReason, 'kb_tool_unavailable');

  const empty = await memos.recallForPlanner('不会调用', {
    config: {
      MEMOS_MCP_ENABLED: false
    }
  });
  assert.strictEqual(empty.used, false);
  assert.strictEqual(empty.rejectedReason, 'disabled');

  assert.deepStrictEqual(memos.normalizeRecallItems({
    text: JSON.stringify({
      code: 0,
      data: {
        memory_detail_list: [],
        preference_detail_list: [],
        tool_memory_detail_list: [],
        skill_detail_list: [],
        preference_note: ''
      },
      message: 'ok'
    })
  }), []);

  const normalizedKbItems = memos.normalizeRecallItems({
    result: {
      data: {
        file_list: [
          { file_id: 'doc-1', file_name: '远端知识库.md', file_content: '远端知识库内容用于只读召回。' }
        ]
      }
    }
  }, { source: 'memos_kb' });
  assert.deepStrictEqual(normalizedKbItems, [
    {
      id: 'doc-1',
      text: '远端知识库内容用于只读召回。',
      title: '远端知识库.md',
      source: 'memos_kb',
      score: null,
      createdAt: ''
    }
  ]);

  const writeAttempt = await memos.addMessageToMemos({ text: '不应写入远端' }, {
    config: {
      MEMOS_MCP_ENABLED: true,
      MEMOS_WRITE_ENABLED: true
    }
  });
  assert.strictEqual(writeAttempt.ok, false);
  assert.strictEqual(writeAttempt.skipped, true);
  assert.strictEqual(writeAttempt.reason, 'remote_write_disabled');

  console.log('memosPlannerRecall.test.js passed');
  clearProjectCache();
})().catch((error) => {
  clearProjectCache();
  console.error(error);
  process.exit(1);
});

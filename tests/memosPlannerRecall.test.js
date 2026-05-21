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
  let expectedToolName = 'search_memory';
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
        assert.strictEqual(toolName, expectedToolName);
        assert.notStrictEqual(toolName, 'add_message');
        if (toolName === 'search_memory') {
          assert.ok(['实现', '设定资料里 Mizuki 的世界观规则是什么 lore/worldbook'].includes(args.query));
          assert.deepStrictEqual(args.knowledgebase_ids, ['basea6e3658a-4f31-4c54-ba83-821fa21f9a44']);
          assert.strictEqual(args.memory_limit_number, 2);
          assert.strictEqual(args.preference_limit_number, 2);
          return {
            result: {
              memories: [
                { id: 'kb-m1', text: '知识库记录：用户偏好先给结论，再补关键细节。', score: 0.91 },
                { id: 'kb-m2', content: '知识库记录：用户正在并行开发，不能覆盖其他人的改动。', score: 0.83 }
              ]
            }
          };
        }
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
  assert.strictEqual(
    memos.buildMemosRecallQuery('继续刚才的实现', {
      config: { MEMOS_RECALL_QUERY_MODE: 'compact' }
    }).query,
    '实现'
  );
  assert.strictEqual(
    memos.evaluateMemosRouteGate('我是谁，刚才聊到哪了', {
      config: { MEMOS_RECALL_LOCAL_QUERY_GUARD_ENABLED: true }
    }).allowed,
    false
  );
  assert.strictEqual(
    memos.evaluateMemosRouteGate('设定资料里 Mizuki 的世界观规则是什么', {
      config: { MEMOS_RECALL_LOCAL_QUERY_GUARD_ENABLED: true }
    }).allowed,
    true
  );

  const recall = await memos.recallForPlanner('继续刚才的实现', {
    config: {
      MEMOS_MCP_ENABLED: true,
      MEMOS_MCP_SERVER_NAME: 'memos-api-mcp',
      MEMOS_RECALL_LOCAL_QUERY_GUARD_ENABLED: false,
      MEMOS_RECALL_TOP_K: 2,
      MEMOS_RECALL_MAX_CHARS: 500,
      MEMOS_RECALL_TIMEOUT_MS: 500,
      MEMOS_USER_ID: 'user-123',
      MEMOS_CHANNEL: 'MODELSCOPE',
      MEMOS_RECALL_SOURCE: 'knowledge_base',
      MEMOS_KB_IDS: ['basea6e3658a-4f31-4c54-ba83-821fa21f9a44'],
      MEMOS_KB_FILE_IDS: []
    }
  });

  assert.strictEqual(recall.used, true);
  assert.strictEqual(recall.items.length, 2);
  assert.ok(recall.promptText.startsWith('[MemOSRecall]'));
  assert.ok(recall.promptText.includes('先给结论'));
  assert.strictEqual(recall.diagnostics.recallSource, 'knowledge_base_search');
  assert.strictEqual(recall.diagnostics.searchToolName, 'search_memory');
  assert.strictEqual(recall.diagnostics.sourceToolName, 'search_memory');
  assert.strictEqual(recall.diagnostics.knowledgebaseIdsCount, 1);
  assert.strictEqual(recall.diagnostics.readOnly, true);
  assert.strictEqual(recall.diagnostics.queryMode, 'compact');
  assert.strictEqual(recall.diagnostics.routeGate.allowed, true);

  const localOnly = await memos.recallForPlanner('我是谁，刚才聊到哪了', {
    config: {
      MEMOS_MCP_ENABLED: true,
      MEMOS_MCP_SERVER_NAME: 'memos-api-mcp',
      MEMOS_RECALL_LOCAL_QUERY_GUARD_ENABLED: true,
      MEMOS_RECALL_SOURCE: 'knowledge_base',
      MEMOS_KB_IDS: ['basea6e3658a-4f31-4c54-ba83-821fa21f9a44']
    }
  });
  assert.strictEqual(localOnly.used, false);
  assert.strictEqual(localOnly.rejectedReason, 'local_memory_query');
  assert.strictEqual(localOnly.diagnostics.routeGate.allowed, false);

  const allowlisted = await memos.recallForPlanner('设定资料里 Mizuki 的世界观规则是什么', {
    routeMeta: { routePolicyKey: 'lore/worldbook' },
    config: {
      MEMOS_MCP_ENABLED: true,
      MEMOS_MCP_SERVER_NAME: 'memos-api-mcp',
      MEMOS_RECALL_ROUTE_ALLOWLIST: 'lore,worldbook',
      MEMOS_RECALL_TOP_K: 2,
      MEMOS_RECALL_SOURCE: 'knowledge_base',
      MEMOS_KB_IDS: ['basea6e3658a-4f31-4c54-ba83-821fa21f9a44']
    }
  });
  assert.strictEqual(allowlisted.used, true);
  assert.strictEqual(allowlisted.diagnostics.routeGate.reason, 'allowlist_match');
  assert.strictEqual(allowlisted.diagnostics.routeGate.matched, 'lore');

  const quality = memos.filterRecallItemsByQuality([
    { id: 'low', text: '低分但非空内容', score: 0.2 },
    { id: 'short', text: '短', score: 0.99 },
    { id: 'good', text: '远端知识库提供足够具体的设定证据。', score: 0.9, title: '设定' }
  ], {
    config: {
      MEMOS_RECALL_MIN_SCORE: 0.5,
      MEMOS_RECALL_MIN_CHARS: 6
    }
  });
  assert.deepStrictEqual(quality.items.map((item) => item.id), ['good']);
  assert.strictEqual(quality.diagnostics.removed, 2);

  expectedToolName = 'get_kb_documents';
  const fileRecall = await memos.recallForPlanner('继续刚才的实现', {
    config: {
      MEMOS_MCP_ENABLED: true,
      MEMOS_MCP_SERVER_NAME: 'memos-api-mcp',
      MEMOS_RECALL_LOCAL_QUERY_GUARD_ENABLED: false,
      MEMOS_RECALL_TOP_K: 2,
      MEMOS_RECALL_MAX_CHARS: 500,
      MEMOS_RECALL_TIMEOUT_MS: 500,
      MEMOS_USER_ID: 'user-123',
      MEMOS_CHANNEL: 'MODELSCOPE',
      MEMOS_RECALL_SOURCE: 'knowledge_base',
      MEMOS_KB_IDS: [],
      MEMOS_KB_FILE_IDS: ['kb-file-1', 'kb-file-2']
    }
  });

  assert.strictEqual(fileRecall.used, true);
  assert.strictEqual(fileRecall.items.length, 2);
  assert.ok(fileRecall.promptText.startsWith('[MemOSRecall]'));
  assert.ok(fileRecall.promptText.includes('先给结论'));
  assert.strictEqual(fileRecall.diagnostics.recallSource, 'knowledge_base');
  assert.strictEqual(fileRecall.diagnostics.kbToolName, 'get_kb_documents');
  assert.strictEqual(fileRecall.diagnostics.sourceToolName, 'get_kb_documents');
  assert.strictEqual(fileRecall.diagnostics.readOnly, true);

  expectedToolName = 'search_memory';
  const missingKbIds = await memos.recallForPlanner('没有配置 kb 文件', {
    config: {
      MEMOS_MCP_ENABLED: true,
      MEMOS_MCP_SERVER_NAME: 'memos-api-mcp',
      MEMOS_RECALL_LOCAL_QUERY_GUARD_ENABLED: false,
      MEMOS_RECALL_SOURCE: 'knowledge_base',
      MEMOS_KB_IDS: [],
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
      callMcpTool: async (_serverName, toolName, args) => {
        assert.strictEqual(toolName, 'search_memory');
        assert.deepStrictEqual(args.knowledgebase_ids, ['basea6e3658a-4f31-4c54-ba83-821fa21f9a44']);
        return { result: { memories: [] } };
      }
    }
  };
  const memosWithoutKbTool = require('../utils/memosPlannerRecall');
  const kbIdWithNoKbDocumentsTool = await memosWithoutKbTool.recallForPlanner('工具缺失', {
    config: {
      MEMOS_MCP_ENABLED: true,
      MEMOS_MCP_SERVER_NAME: 'memos-api-mcp',
      MEMOS_RECALL_LOCAL_QUERY_GUARD_ENABLED: false,
      MEMOS_RECALL_SOURCE: 'knowledge_base',
      MEMOS_KB_IDS: ['basea6e3658a-4f31-4c54-ba83-821fa21f9a44'],
      MEMOS_KB_FILE_IDS: ['kb-file-1']
    }
  });
  assert.strictEqual(kbIdWithNoKbDocumentsTool.used, false);
  assert.strictEqual(kbIdWithNoKbDocumentsTool.rejectedReason, 'empty_result');
  assert.strictEqual(kbIdWithNoKbDocumentsTool.diagnostics.recallSource, 'knowledge_base_search');

  const missingKbTool = await memosWithoutKbTool.recallForPlanner('工具缺失', {
    config: {
      MEMOS_MCP_ENABLED: true,
      MEMOS_MCP_SERVER_NAME: 'memos-api-mcp',
      MEMOS_RECALL_LOCAL_QUERY_GUARD_ENABLED: false,
      MEMOS_RECALL_SOURCE: 'knowledge_base',
      MEMOS_KB_IDS: [],
      MEMOS_KB_FILE_IDS: ['kb-file-1'],
      MEMOS_KB_FALLBACK_SEARCH_ENABLED: false
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

  const structuredMcpItems = memos.normalizeRecallItems({
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            code: 0,
            data: {
              memory_detail_list: [
                { id: 'json-1', memory_key: '远端知识', memory_value: '从 structured MCP JSON 内部抽取。' }
              ]
            }
          })
        }
      ]
    },
    text: JSON.stringify({ should_not: '成为 prompt 文本' })
  }, { source: 'memos_kb' });
  assert.strictEqual(structuredMcpItems.length, 1);
  assert.strictEqual(structuredMcpItems[0].text, '从 structured MCP JSON 内部抽取。');
  assert.ok(!structuredMcpItems[0].text.includes('memory_detail_list'));

  const nestedObjectItems = memos.normalizeRecallItems({
    result: {
      data: {
        memory_detail_list: [
          { id: 'obj-1', memory_key: '嵌套对象', memory_value: { nested: '不要进入 prompt' } },
          { id: 'obj-2', memory_key: '文本对象', memory_value: '只保留字符串内容。' }
        ]
      }
    }
  });
  assert.strictEqual(nestedObjectItems.length, 1);
  assert.strictEqual(nestedObjectItems[0].text, '只保留字符串内容。');
  assert.ok(!nestedObjectItems.some((item) => item.text.includes('[object Object]')));

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

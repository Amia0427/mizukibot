const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-main-reply-admin-diag-'));

  try {
    process.env.DATA_DIR = tempDir;
    process.env.API_BASE_URL = 'https://diag-admin.example/v1/chat/completions';
    process.env.API_KEY = 'diag-key';
    process.env.AI_MODEL = 'diag-model';
    process.env.PLANNER_SUBAGENT_ENABLED = 'false';
    process.env.ENABLE_AI_ROUTER = 'false';
    process.env.COMPANION_TOOL_MODE_ENABLED = 'false';
    process.env.MEMORY_EMBEDDING_ENABLED = '0';
    process.env.MEMORY_RERANK_ENABLED = '0';
    process.env.PERSONA_WORLDBOOK_EMBEDDING_ENABLED = 'false';
    process.env.PERSONA_WORLDBOOK_RERANK_ENABLED = 'false';

    clearProjectCache();
    const httpClient = require('../api/httpClient');
    httpClient.postWithRetry = async () => ({ data: { choices: [{ message: { content: 'ok' } }] } });

    const { createMessageRouteFlow } = require('../core/messageRouteFlow');
    const sent = [];
    const routeFlow = createMessageRouteFlow({
      config: {},
      isAdminUser: (userId) => userId === 'admin_1',
      sendGroupReply: async (payload) => {
        sent.push(payload);
        return true;
      }
    });

    const result = await routeFlow.dispatchAdminRoute({
      route: {
        topRouteType: 'admin',
        meta: {
          admin: true,
          command: {
            cmd: 'debug',
            args: ['replydiag', '{"requestText":"查下今天上海天气","userId":"u_diag","groupId":"g_diag","chatType":"group","plannerMode":"rule"}'],
            raw: '/debug replydiag {"requestText":"查下今天上海天气","userId":"u_diag","groupId":"g_diag","chatType":"group","plannerMode":"rule"}'
          }
        }
      },
      groupId: 'g_diag',
      senderId: 'admin_1',
      rawText: '/debug replydiag {"requestText":"查下今天上海天气","userId":"u_diag","groupId":"g_diag","chatType":"group","plannerMode":"rule"}',
      userInfo: null,
      chatType: 'group'
    });

    assert.strictEqual(result.handled, true);
    assert.strictEqual(sent.length, 1);
    const report = JSON.parse(sent[0].replyText);
    assert.strictEqual(report.schemaVersion, 'main_reply_diagnostic_v1');
    assert.strictEqual(report.input.userId, 'u_diag');
    assert.strictEqual(report.input.groupId, 'g_diag');
    assert.strictEqual(report.diagnostics.plannerSource, 'rule');
    assert.ok(Object.prototype.hasOwnProperty.call(report, 'memoryFreshness'));
    assert.ok(Object.prototype.hasOwnProperty.call(report, 'guards'));
    assert.ok(Object.prototype.hasOwnProperty.call(report.branch, 'finalBranch'));

    const cacheResult = await routeFlow.dispatchAdminRoute({
      route: {
        topRouteType: 'admin',
        meta: {
          admin: true,
          command: {
            cmd: 'debug',
            args: ['replycache'],
            raw: '/debug replycache'
          }
        }
      },
      groupId: 'g_diag',
      senderId: 'admin_1',
      rawText: '/debug replycache',
      userInfo: null,
      chatType: 'group'
    });

    assert.strictEqual(cacheResult.handled, true);
    assert.strictEqual(sent.length, 2);
    const cacheReport = JSON.parse(sent[1].replyText);
    assert.strictEqual(cacheReport.schemaVersion, 'main_reply_cache_stats_v1');
    assert.ok(Array.isArray(cacheReport.sources));
    assert.strictEqual(cacheReport.signals.noRecentMainReplyCalls, true);

    const truncResult = await routeFlow.dispatchAdminRoute({
      route: {
        topRouteType: 'admin',
        meta: {
          admin: true,
          command: {
            cmd: 'debug',
            args: ['replytrunc'],
            raw: '/debug replytrunc'
          }
        }
      },
      groupId: 'g_diag',
      senderId: 'admin_1',
      rawText: '/debug replytrunc',
      userInfo: null,
      chatType: 'group'
    });

    assert.strictEqual(truncResult.handled, true);
    assert.strictEqual(sent.length, 3);
    const truncReport = JSON.parse(sent[2].replyText);
    assert.strictEqual(truncReport.schemaVersion, 'main_reply_truncation_diagnostic_v1');
    assert.ok(Array.isArray(truncReport.summary.topReasons));
    assert.strictEqual(truncReport.summary.noRecentTruncationCandidates, true);

    const runtimeResult = await routeFlow.dispatchAdminRoute({
      route: {
        topRouteType: 'admin',
        meta: {
          admin: true,
          command: {
            cmd: 'debug',
            args: ['runtime'],
            raw: '/debug runtime'
          }
        }
      },
      groupId: 'g_diag',
      senderId: 'admin_1',
      rawText: '/debug runtime',
      userInfo: null,
      chatType: 'group'
    });

    assert.strictEqual(runtimeResult.handled, true);
    assert.strictEqual(sent.length, 4);
    const runtimeReport = JSON.parse(sent[3].replyText);
    assert.strictEqual(runtimeReport.schemaVersion, 'runtime_status_diagnostic_v1');
    assert.ok(Object.prototype.hasOwnProperty.call(runtimeReport, 'summary'));
    assert.ok(Object.prototype.hasOwnProperty.call(runtimeReport, 'components'));
    assert.ok(Array.isArray(runtimeReport.signals));
    assert.ok(Object.prototype.hasOwnProperty.call(runtimeReport.components, 'postReplyWorker'));
    assert.ok(Object.prototype.hasOwnProperty.call(runtimeReport.components, 'backgroundTasks'));
    assert.ok(!Object.prototype.hasOwnProperty.call(runtimeReport.components, 'subagents'));

    const hotspotsResult = await routeFlow.dispatchAdminRoute({
      route: {
        topRouteType: 'admin',
        meta: {
          admin: true,
          command: {
            cmd: 'debug',
            args: ['hotspots'],
            raw: '/debug hotspots'
          }
        }
      },
      groupId: 'g_diag',
      senderId: 'admin_1',
      rawText: '/debug hotspots',
      userInfo: null,
      chatType: 'group'
    });

    assert.strictEqual(hotspotsResult.handled, true);
    assert.strictEqual(sent.length, 5);
    const hotspotsReport = JSON.parse(sent[4].replyText);
    assert.strictEqual(hotspotsReport.schemaVersion, 'runtime_hotspots_diagnostic_v1');
    assert.ok(Object.prototype.hasOwnProperty.call(hotspotsReport, 'resources'));
    assert.ok(Object.prototype.hasOwnProperty.call(hotspotsReport, 'runtime'));
    assert.ok(Object.prototype.hasOwnProperty.call(hotspotsReport, 'modules'));

    const providerResult = await routeFlow.dispatchAdminRoute({
      route: {
        topRouteType: 'admin',
        meta: {
          admin: true,
          command: {
            cmd: 'debug',
            args: ['provider', 'gemini_native', '--scenario', 'http_client_direct'],
            raw: '/debug provider gemini_native --scenario http_client_direct'
          }
        }
      },
      groupId: 'g_diag',
      senderId: 'admin_1',
      rawText: '/debug provider gemini_native --scenario http_client_direct',
      userInfo: null,
      chatType: 'group'
    });

    assert.strictEqual(providerResult.handled, true);
    assert.strictEqual(sent.length, 6);
    const providerReport = JSON.parse(sent[5].replyText);
    assert.strictEqual(providerReport.schemaVersion, 'provider_request_diagnostic_v1');
    assert.strictEqual(providerReport.scenarios[0].finalProvider, 'gemini_native');
    assert.strictEqual(providerReport.scenarios[0].auth.header, 'x-goog-api-key');

    const promptAssemblyResult = await routeFlow.dispatchAdminRoute({
      route: {
        topRouteType: 'admin',
        meta: {
          admin: true,
          command: {
            cmd: 'debug',
            args: ['replyprompt', '{"requestText":"服饰专门学校和N25两个都不放弃","userId":"u_diag","chatType":"private","sessionKey":"admin-replyprompt-test"}'],
            raw: '/debug replyprompt {"requestText":"服饰专门学校和N25两个都不放弃","userId":"u_diag","chatType":"private","sessionKey":"admin-replyprompt-test"}'
          }
        }
      },
      groupId: 'g_diag',
      senderId: 'admin_1',
      rawText: '/debug replyprompt {"requestText":"服饰专门学校和N25两个都不放弃","userId":"u_diag","chatType":"private","sessionKey":"admin-replyprompt-test"}',
      userInfo: null,
      chatType: 'group'
    });

    assert.strictEqual(promptAssemblyResult.handled, true);
    assert.strictEqual(sent.length, 7);
    const promptAssemblyReport = JSON.parse(sent[6].replyText);
    assert.strictEqual(promptAssemblyReport.schemaVersion, 'main_reply_prompt_assembly_diagnostic_v1');
    assert.strictEqual(promptAssemblyReport.mode, 'test_input');
    assert.ok(Object.prototype.hasOwnProperty.call(promptAssemblyReport, 'promptAssembly'));

    const checkResult = await routeFlow.dispatchAdminRoute({
      route: {
        topRouteType: 'admin',
        meta: {
          admin: true,
          command: {
            cmd: 'check',
            args: [],
            raw: '/check'
          }
        }
      },
      groupId: 'g_diag',
      senderId: 'admin_1',
      rawText: '/check',
      userInfo: null,
      chatType: 'group'
    });

    assert.strictEqual(checkResult.handled, true);
    assert.strictEqual(sent.length, 8);
    assert.ok(sent[7].replyText.includes('模型自检:'));
    assert.ok(sent[7].replyText.includes('plan |'));
    assert.ok(sent[7].replyText.includes('main_reply |'));
    assert.ok(!sent[7].replyText.includes('https://'));
    assert.ok(!sent[7].replyText.includes('diag-key'));

    const deniedCheckResult = await routeFlow.dispatchAdminRoute({
      route: {
        topRouteType: 'admin',
        meta: {
          admin: false,
          command: {
            cmd: 'check',
            args: [],
            raw: '/check'
          }
        }
      },
      groupId: 'g_diag',
      senderId: 'user_1',
      rawText: '/check',
      userInfo: null,
      chatType: 'group'
    });

    assert.strictEqual(deniedCheckResult.handled, true);
    assert.strictEqual(sent.length, 9);
    assert.strictEqual(sent[8].replyText, '这个按钮现在只给管理员按哦。');

    const helpResult = await routeFlow.dispatchAdminRoute({
      route: {
        topRouteType: 'admin',
        meta: {
          admin: true,
          command: {
            cmd: 'help',
            args: [],
            raw: '/help'
          }
        }
      },
      groupId: 'g_diag',
      senderId: 'admin_1',
      rawText: '/help',
      userInfo: null,
      chatType: 'group'
    });

    assert.strictEqual(helpResult.handled, true);
    assert.strictEqual(sent.length, 10);
    assert.ok(sent[9].replyText.includes('/check'));
    assert.ok(sent[9].replyText.includes('replyprompt'));

    console.log('mainReplyDiagnosticsAdminCommand.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

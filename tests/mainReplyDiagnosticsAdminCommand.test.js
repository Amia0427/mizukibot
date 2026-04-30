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

    clearProjectCache();

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

    console.log('mainReplyDiagnosticsAdminCommand.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

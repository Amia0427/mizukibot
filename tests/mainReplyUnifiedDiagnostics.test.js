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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-main-reply-diag-'));

  try {
    process.env.DATA_DIR = tempDir;
    process.env.API_BASE_URL = 'https://diag.example/v1/chat/completions';
    process.env.API_KEY = 'diag-key';
    process.env.AI_MODEL = 'diag-model';
    process.env.AI_FALLBACK_ENABLED = 'true';
    process.env.AI_FALLBACK_MODEL = 'diag-fallback-model';
    process.env.PLANNER_SUBAGENT_ENABLED = 'false';
    process.env.ENABLE_AI_ROUTER = 'false';
    process.env.COMPANION_TOOL_MODE_ENABLED = 'false';

    clearProjectCache();

    const { buildMainReplyDiagnosticReport } = require('../utils/mainReplyDiagnostics');
    const report = await buildMainReplyDiagnosticReport({
      rawText: '[CQ:at,qq=3326471600] 日麻怎么入门？',
      requestText: '日麻怎么入门？',
      userId: 'u_diag',
      groupId: 'g_diag',
      chatType: 'group',
      plannerMode: 'rule',
      candidateReply: '最先要记的：役是什么。然后理解立直。还有一个坑是振听。推荐的入门路子是先打低段位再复盘。'.repeat(8)
    }, {
      plannerMode: 'rule'
    });

    assert.strictEqual(report.schemaVersion, 'main_reply_diagnostic_v1');
    assert.ok(report.checkedAt);
    assert.strictEqual(report.summary.routeDebugKey, report.route.routeDebugKey);
    assert.strictEqual(report.summary.provider, 'openai_compatible');
    assert.strictEqual(report.summary.model, 'diag-model');
    assert.strictEqual(report.summary.finalBranch, report.branch.finalBranch);

    assert.strictEqual(report.input.userId, 'u_diag');
    assert.strictEqual(report.input.groupId, 'g_diag');
    assert.strictEqual(report.input.chatType, 'group');
    assert.strictEqual(report.route.routeDebugKey, 'direct_chat/text_chat/answer');
    assert.strictEqual(report.route.routePolicyKey, 'chat/default');

    assert.ok(['direct', 'tool', 'background', 'unavailable'].includes(report.branch.finalBranch));
    assert.ok(Object.prototype.hasOwnProperty.call(report.model, 'fallback'));
    assert.strictEqual(report.model.model, 'diag-model');
    assert.strictEqual(report.model.apiBaseUrlHost, 'diag.example');
    assert.strictEqual(report.model.fallback.enabled, true);
    assert.strictEqual(report.model.fallback.configured, true);

    assert.ok(Object.prototype.hasOwnProperty.call(report.memoryFreshness, 'projectionStale'));
    assert.ok(Object.prototype.hasOwnProperty.call(report.memoryFreshness, 'usedOldSnapshot'));
    assert.ok(Object.prototype.hasOwnProperty.call(report.memoryFreshness, 'latestRelevantEventTs'));

    assert.strictEqual(report.guards.groupDirectStyle.eligible, true);
    assert.strictEqual(report.guards.groupDirectStyle.checkedReply, true);
    assert.strictEqual(report.guards.groupDirectStyle.hit, true);
    assert.ok(report.guards.groupDirectStyle.reasons.includes('too_long'));
    assert.ok(report.guards.groupDirectStyle.reasons.includes('teaching_structure'));
    assert.strictEqual(report.diagnostics.plannerSource, 'rule');

    console.log('mainReplyUnifiedDiagnostics.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

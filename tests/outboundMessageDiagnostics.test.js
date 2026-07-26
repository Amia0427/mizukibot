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

function findOutbound(events, expected = {}) {
  return events.find((event) => (
    event?.category === 'outbound_message'
    && event?.stage === 'outbound_message_send_success'
    && String(event?.source || '') === expected.source
    && String(event?.routePolicyKey || '') === expected.routePolicyKey
    && String(event?.triggerReason || '') === expected.triggerReason
  ));
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-outbound-diag-'));
  let personaMemory = null;
  let originalRecord = null;

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDir;
    process.env.PERF_LOG_ENABLED = 'false';
    process.env.PROACTIVE_GREETING_FALLBACK_ENABLED = 'true';
    process.env.PROACTIVE_GREETING_MORNING_FALLBACK_AT = '11:40';
    process.env.PROACTIVE_REPLY_ENABLED = 'true';
    process.env.PROACTIVE_REPLY_MIN_POINTS = '150';
    process.env.SCHEDULED_GREETING_MIN_POINTS = '250';
    process.env.INITIATIVE_POLICY_ENABLED = 'true';
    process.env.INITIATIVE_DECISION_ENABLED = 'true';
    process.env.INITIATIVE_DECISION_API_BASE_URL = '';
    process.env.INITIATIVE_DECISION_API_KEY = '';
    process.env.INITIATIVE_DECISION_MODEL = '';
    clearProjectCache();

    personaMemory = require('../utils/personaMemoryState');
    originalRecord = personaMemory.recordPersonaMemoryOutcome;
    personaMemory.recordPersonaMemoryOutcome = async () => ({ ok: true });
    const { sendGroupReply } = require('../core/systemGroupReply');
    const { sendGroupMessage } = require('../api/qqActionService');
    const { createStreamingDispatcher } = require('../src/message/streaming');
    const { runGreetingFallbacks } = require('../core/tickEngine');
    const { getRecentPerfEvents } = require('../utils/perfRuntime');
    const memory = require('../utils/memory');

    await sendGroupReply({
      sendWithRetry: async () => true,
      groupId: 'g-main',
      senderId: 'u-main',
      replyText: '主回复诊断',
      source: 'main_reply',
      routePolicyKey: 'chat/default',
      triggerReason: 'direct_reply.final_send'
    });

    await sendGroupMessage('g-scheduled', '定时消息诊断', {
      actionClient: {
        async callAction() {
          return { ok: true };
        }
      },
      source: 'scheduler_runtime',
      routePolicyKey: 'scheduled/group-message',
      triggerReason: 'scheduled_task_due'
    });

    const streamingDispatcher = createStreamingDispatcher({
      sendWithRetry: async () => true,
      chatType: 'group',
      groupId: 'g-stream',
      userId: 'u-stream',
      senderId: 'u-stream',
      source: 'main_reply',
      routePolicyKey: 'chat/default',
      triggerReason: 'direct_reply.final_send'
    });
    await streamingDispatcher.finish('流式主回复诊断');

    memory.favorites['u-fallback-diagnostic'] = {
      points: 999,
      group_id: 'g-fallback-diagnostic',
      last_seen_at: Date.now() - (5 * 60 * 60 * 1000)
    };
    memory.saveData();
    const state = {};
    const actionClient = {
      async callAction() {
        return { ok: true };
      }
    };
    const sentFallback = await runGreetingFallbacks(actionClient, async () => {
      throw new Error('fallback branch should not call model');
    }, state, new Date('2026-04-17T11:45:00+08:00'));
    assert.strictEqual(sentFallback, true);

    const events = getRecentPerfEvents({ limit: 200 });
    assert.ok(findOutbound(events, {
      source: 'main_reply',
      routePolicyKey: 'chat/default',
      triggerReason: 'direct_reply.final_send'
    }), 'main reply send should expose source, routePolicyKey and triggerReason');
    assert.ok(events.some((event) => (
      event?.category === 'outbound_message'
      && event?.stage === 'outbound_message_send_success'
      && event?.action === 'send_group_msg'
      && event?.groupId === 'g-stream'
      && event?.source === 'main_reply'
      && event?.routePolicyKey === 'chat/default'
      && event?.triggerReason === 'direct_reply.final_send'
    )), 'main reply stream send should expose source, routePolicyKey and triggerReason');
    assert.ok(findOutbound(events, {
      source: 'scheduler_runtime',
      routePolicyKey: 'scheduled/group-message',
      triggerReason: 'scheduled_task_due'
    }), 'scheduled group message should expose source, routePolicyKey and triggerReason');
    assert.ok(findOutbound(events, {
      source: 'fallback_greeting',
      routePolicyKey: 'proactive/default',
      triggerReason: 'fallback_morning_greeting'
    }), 'tickEngine fallback send should expose source, routePolicyKey and triggerReason');

    console.log('outboundMessageDiagnostics.test.js passed');
  } finally {
    if (personaMemory && originalRecord) {
      personaMemory.recordPersonaMemoryOutcome = originalRecord;
    }
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

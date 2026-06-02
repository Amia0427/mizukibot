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
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-proactive-private-'));

  try {
    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = tempDataDir;
    process.env.TIMEZONE = 'Asia/Shanghai';
    process.env.SHORT_TERM_SESSION_SCOPE_ENABLED = 'true';
    process.env.PROACTIVE_REPLY_ENABLED = 'true';
    process.env.PROACTIVE_REPLY_IDLE_MINUTES = '45';
    process.env.PROACTIVE_PRIVATE_TOUCH_ENABLED = 'true';
    process.env.PROACTIVE_PRIVATE_TOUCH_USER_IDS = 'u-private';
    process.env.PROACTIVE_PRIVATE_TOUCH_MIN_POINTS = '150';
    process.env.PROACTIVE_PRIVATE_TOUCH_REQUIRE_CONTEXT = 'true';
    process.env.PROACTIVE_PRIVATE_TOUCH_ALLOW_LIGHT_CARE = 'false';

    clearProjectCache();

    const memory = require('../utils/memory');
    const { shortTermMemory } = memory;
    memory.favorites['u-private'] = {
      points: 999,
      group_id: 'g-private-source',
      last_seen_at: 0
    };
    memory.favorites['u-skip'] = {
      points: 999,
      group_id: 'g-private-source',
      last_seen_at: 0
    };
    shortTermMemory['direct:u-private'] = {
      openLoops: ['上次说要继续看部署日志'],
      assistantCommitments: [],
      activeTopic: '部署日志'
    };
    shortTermMemory['direct:u-skip'] = {
      openLoops: ['非白名单不该收到'],
      assistantCommitments: [],
      activeTopic: '跳过'
    };

    const personaMemory = require('../utils/personaMemoryState');
    const originalCompose = personaMemory.composePersonaMemoryState;
    const originalRender = personaMemory.renderPersonaMemoryPrompt;
    const originalRecord = personaMemory.recordPersonaMemoryOutcome;
    const composeCalls = [];
    const recordedPayloads = [];
    personaMemory.composePersonaMemoryState = async (request, options) => {
      composeCalls.push({ request, options });
      return {
        surface: options.surface,
        relationshipState: {},
        continuityState: { openLoops: ['上次说要继续看部署日志'] },
        expressionState: {},
        memoryDigest: { items: [] },
        personaCore: { text: '' }
      };
    };
    personaMemory.renderPersonaMemoryPrompt = (state, surface) => ({
      systemMessages: [{ role: 'system', content: `[SurfacePolicy]\nsurface=${surface}\nchat_discipline=single` }],
      policy: { privacyMode: 'private', chatDiscipline: 'single' }
    });
    personaMemory.recordPersonaMemoryOutcome = async (surface, payload) => {
      recordedPayloads.push({ surface, payload });
      return { ok: true };
    };

    const {
      canTriggerProactivePrivateReply,
      resolveProactivePrivateTouchUserIds,
      runPrivateWindowTouches
    } = require('../core/tickEngine');

    const config = require('../config');
    assert.deepStrictEqual(resolveProactivePrivateTouchUserIds(config, memory.favorites), ['u-private']);
    assert.strictEqual(canTriggerProactivePrivateReply('u-private', memory.favorites['u-private'], {}, '2026-06-02', Date.now(), config), true);
    assert.strictEqual(canTriggerProactivePrivateReply('u-skip', memory.favorites['u-skip'], {}, '2026-06-02', Date.now(), config), false);

    const sentPackets = [];
    const ws = {
      send(payload) {
        sentPackets.push(JSON.parse(payload));
      }
    };
    const askCalls = [];
    const sent = await runPrivateWindowTouches(ws, async (prompt, data, userId, _rawPrompt, _unused, options) => {
      askCalls.push({ prompt, data, userId, options });
      return '那份部署日志，你后来有新报错吗';
    }, {}, new Date('2026-06-02T10:59:00+08:00'));

    assert.strictEqual(sent, true);
    assert.strictEqual(sentPackets.length, 1);
    assert.strictEqual(sentPackets[0].action, 'send_private_msg');
    assert.strictEqual(sentPackets[0].params.user_id, 'u-private');
    assert.ok(!String(sentPackets[0].params.message || '').includes('[CQ:at'));
    assert.strictEqual(askCalls.length, 1);
    assert.strictEqual(askCalls[0].userId, 'u-private');
    assert.strictEqual(askCalls[0].options.routeMeta.chatType, 'private');
    assert.strictEqual(askCalls[0].options.routeMeta.surface, 'proactive_private_touch');
    assert.ok(askCalls[0].prompt.includes('surface=proactive_private_touch'));
    assert.ok(askCalls[0].prompt.includes('一对一私聊'));
    assert.strictEqual(askCalls[0].data.group_id, '');
    assert.strictEqual(composeCalls[0].options.surface, 'proactive_private_touch');
    assert.strictEqual(composeCalls[0].request.routeMeta.chatType, 'private');
    assert.strictEqual(recordedPayloads.length, 1);
    assert.strictEqual(recordedPayloads[0].surface, 'proactive_private_touch');

    personaMemory.composePersonaMemoryState = originalCompose;
    personaMemory.renderPersonaMemoryPrompt = originalRender;
    personaMemory.recordPersonaMemoryOutcome = originalRecord;

    // Whitespace keeps local .env fallback from repopulating this key, while config pick() still treats it as empty.
    process.env.PROACTIVE_PRIVATE_TOUCH_USER_IDS = ' ';
    process.env.PRIVATE_CHAT_TEST_USER_IDS = '*';
    clearProjectCache();
    const wildcardConfig = require('../config');
    const wildcardPrivileged = require('../utils/privilegedPrivateChat');
    assert.deepStrictEqual(Array.from(wildcardPrivileged.getProactivePrivateTouchUserIdSet(wildcardConfig)), []);

    console.log('proactivePrivateTouch.test.js passed');
  } finally {
    restoreEnv(snapshot);
    clearProjectCache();
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

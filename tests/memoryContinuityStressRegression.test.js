const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-continuity-stress-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_HYBRID_RECALL_ENABLED = 'false';
process.env.MEMORY_EMBEDDING_MODEL = '';
process.env.SHORT_TERM_MEMORY_MAX_TOKENS = '60';
process.env.SHORT_TERM_MEMORY_SUMMARY_MAX_TOKENS = '180';
process.env.SHORT_TERM_MEMORY_RECENT_MESSAGES = '2';
process.env.SHORT_TERM_MEMORY_MAX_COMPRESSION_ROUNDS = '4';
process.env.SESSION_CONTEXT_SUMMARY_COOLDOWN_MS = '0';

fs.mkdirSync(tempRoot, { recursive: true });

const { createPersistNode } = require('../api/runtimeV2/nodes/persist');
const {
  appendShortTermHistory,
  buildShortTermContextMessages,
  buildStructuredCompressionPrompt,
  compressShortTermHistoryIfNeeded,
  ensureShortTermMemoryState
} = require('../utils/shortTermMemory');
const { persistShortTermBridgeSnapshot, loadBridgeStore } = require('../utils/shortTermBridgeMemory');
const {
  getSessionContextSummaryStoreSnapshot,
  getSessionSummaryCooldownStatus,
  reloadSessionContextSummaryStore,
  saveSessionContextSummary
} = require('../utils/sessionContextSummaryStore');
const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');
const { buildMemoryContextAsync } = require('../utils/memoryContext');

function pad(text) {
  return [
    text,
    '这是连续性压力测试，需要保留主线、约束、承诺和没填完的坑。',
    '如果后面继续追问，不能把前面聊过的重点丢掉。'
  ].join(' ');
}

function summarizeChunkFromText(chunkText = '') {
  const text = String(chunkText || '');
  const items = [];
  const openLoops = [];

  if (text.includes('首尾帧')) items.push('首尾帧生成动画方案');
  if (text.includes('多agent') || text.includes('Planner Worker Reviewer')) items.push('多agent架构');
  if (text.includes('前端丑') || text.includes('GPT 前端')) items.push('吐槽过GPT前端丑');
  if (text.includes('生日')) {
    items.push('生日快到了但具体日期没说');
    openLoops.push('生日具体日期还没说');
  }

  return {
    summary: items.length > 0 ? `前面已经聊过：${items.join('、')}。` : '前面已经聊过连续追问主线。',
    activeTopic: '连续追问压力测试',
    openLoops,
    assistantCommitments: ['后续回答继续沿着原主线，不装失忆'],
    userConstraints: ['回答要直接，别失忆'],
    recentToolResults: [],
    carryOverUserTurn: '',
    interaction: {
      activeTopic: '连续追问压力测试',
      carryOverUserTurn: '',
      openLoops,
      assistantCommitments: ['后续回答继续沿着原主线，不装失忆'],
      userConstraints: ['回答要直接，别失忆'],
      recentTurns: [],
      phaseHint: '',
      sourceFlags: ['compression'],
      confidence: 0.88
    },
    scene: {
      sceneKey: '',
      activeTopic: '',
      atmosphere: '',
      activePair: '',
      quoteAnchor: '',
      jargonHints: [],
      recentTurns: [],
      confidence: 0
    },
    expression: {
      replyPosture: 'focused',
      warmth: '',
      guardedness: '',
      initiative: '',
      jargonMode: '',
      cadenceHint: '',
      styleAnchors: ['先给结论', '别失忆'],
      confidence: 0.8
    },
    moduleState: {
      activePersonaModules: [],
      stickyTurnsRemaining: 0,
      switchReason: '',
      lastSurface: '',
      lastTopicFingerprint: '',
      lastUpdatedAt: 0
    },
    phaseHint: '',
    sceneRef: '',
    confidence: 0.88
  };
}

function buildAutoSummary(state, history = []) {
  const latestTurns = (Array.isArray(history) ? history : [])
    .slice(-4)
    .map((item) => String(item?.content || '').trim())
    .filter(Boolean)
    .join(' | ');

  return [
    `当前主线：${String(state.activeTopic || '').trim() || '连续追问压力测试'}`,
    String(state.summary || '').trim(),
    state.openLoops.length > 0 ? `未完成事项：${state.openLoops.join('、')}` : '',
    latestTurns ? `最近几句：${latestTurns}` : ''
  ].filter(Boolean).join('；');
}

module.exports = (async () => {
  const userId = 'u_stress_memory';
  const sessionKey = 'direct:u_stress_memory';
  const chatHistory = {};
  const shortTermMemory = {};

  const persistNode = createPersistNode({
    normalizeObject(value, fallback = {}) {
      return value && typeof value === 'object' ? value : fallback;
    },
    normalizeArray(value) {
      return Array.isArray(value) ? value : [];
    },
    createEvent(type, payload = {}) {
      return { type, ...payload };
    },
    isReviewMode() {
      return false;
    },
    isChatLikeRoute() {
      return true;
    },
    shouldAppendDailyJournalForV2() {
      return false;
    },
    shouldQueueMemoryLearningForV2() {
      return false;
    },
    shouldLearnSelfImprovement() {
      return false;
    },
    compressShortTermHistoryIfNeeded,
    summarizeShortTermChunk: async (payload = {}) => JSON.stringify(summarizeChunkFromText(payload.chunkText)),
    getSessionSummaryCooldownStatus,
    saveSessionContextSummary,
    generateSessionContextSummary: async ({ sessionKey: key, shortTermMemory: memoryStore, chatHistory: historyStore }) => {
      const state = ensureShortTermMemoryState(key, memoryStore);
      const history = Array.isArray(historyStore[key]) ? historyStore[key] : [];
      return {
        ok: true,
        summary: buildAutoSummary(state, history),
        structured: {
          activeTopic: state.activeTopic,
          carryOverUserTurn: state.carryOverUserTurn,
          openLoops: state.openLoops,
          assistantCommitments: state.assistantCommitments,
          userConstraints: state.userConstraints,
          recentTurns: history.slice(-4)
        }
      };
    },
    appendShortTermHistory,
    persistShortTermBridgeSnapshot,
    recordPersonaMemoryOutcome: async () => ({ persisted: false, updatedSlots: {} }),
    appendMemoryEvent,
    materializeMemoryViews,
    addProfileItem() {},
    pickRouteMetaForPostReplyJob(routeMeta) {
      return routeMeta || {};
    },
    stableHash(value) {
      return JSON.stringify(value || {});
    },
    postReplyJobQueue: {
      enqueue() {
        return { enqueued: false, job: null };
      }
    },
    saveAndEmit(state) {
      return state;
    },
    config: {
      MEMORY_V3_ENABLED: true
    },
    chatHistory,
    shortTermMemory
  });

  const turns = [
    {
      question: pad('今天先把首尾帧生成动画方案敲定一下，我还想保留之前说的镜头衔接和转场约束。'),
      reply: pad('先给结论：首尾帧动画方案继续沿用上一版，重点保留镜头衔接、转场和时长控制。')
    },
    {
      question: pad('然后继续聊多agent架构，还是 Planner Worker Reviewer 那套，但你别忘了我要的是直接一点的回答。'),
      reply: pad('记着的，主线还是 Planner Worker Reviewer，多代理拆分时我会先给结论，再给步骤。')
    },
    {
      question: pad('还有我们前面吐槽过 GPT 前端丑，这个 UI 偏见也记一下。'),
      reply: pad('记下来了，你前面明确吐槽过 GPT 前端丑，后续如果聊前端我会优先按更直接、别套模板的方向来。')
    },
    {
      question: pad('对了我快过生日了，但我还没告诉你具体几号，这个坑你别漏。'),
      reply: pad('收到，当前未完成事项里要保留“生日具体日期还没说”，下次你追问时不能装失忆。')
    },
    {
      question: pad('最后再确认一次，你之后回答要先给结论，别把前面那些主线忘了。'),
      reply: pad('记住了，后续回答会先给结论，并延续前面的动画方案、多agent、前端吐槽和生日未完成事项。')
    }
  ];

  for (const turn of turns) {
    await persistNode({
      request: {
        userId,
        userInfo: { level: 'friend' },
        question: turn.question,
        runtimeQuestionText: turn.question,
        persistUserText: turn.question,
        routeMeta: {},
        sessionKey,
        routePolicyKey: 'direct_chat/default',
        topRouteType: 'direct_chat'
      },
      output: {
        finalReply: turn.reply
      },
      memory: {
        continuityState: {
          payload: {
            active_topic: '连续追问压力测试',
            open_loops: [],
            assistant_commitments: ['后续回答继续沿着原主线，不装失忆'],
            user_constraints: ['回答要直接，别失忆'],
            carry_over_user_turn: ''
          }
        }
      },
      execution: {},
      thread: {
        sessionScope: {
          sessionKey,
          userId
        }
      },
      plan: {}
    });
  }

  const state = ensureShortTermMemoryState(sessionKey, shortTermMemory);
  assert.strictEqual(String(state.summarySource || '').trim(), 'compression');
  assert.ok(String(state.summary || '').includes('首尾帧生成动画方案'));
  assert.ok(String(state.summary || '').includes('多agent架构'));
  assert.ok(String(state.summary || '').includes('吐槽过GPT前端丑'));
  assert.ok(String(state.summary || '').includes('生日快到了但具体日期没说'));
  assert.ok(Array.isArray(chatHistory[sessionKey]));
  assert.ok(chatHistory[sessionKey].length <= 2, 'recent history should be compacted down to the reserved tail');

  const bridgeStore = loadBridgeStore();
  assert.ok(bridgeStore.sessions[sessionKey], 'post-reply bridge snapshot should exist');
  assert.strictEqual(bridgeStore.sessions[sessionKey].snapshotType, 'post_reply');
  assert.ok(String(bridgeStore.sessions[sessionKey].shortTermState.summary || '').includes('首尾帧生成动画方案'));

  reloadSessionContextSummaryStore();
  const summaryStore = getSessionContextSummaryStoreSnapshot();
  const sessionSummaries = Array.isArray(summaryStore.sessions?.[sessionKey]) ? summaryStore.sessions[sessionKey] : [];
  assert.ok(sessionSummaries.length > 0, 'auto session summaries should be persisted');
  const latestSummary = sessionSummaries[sessionSummaries.length - 1];
  assert.strictEqual(latestSummary.trigger, 'auto_post_reply');
  assert.ok(String(latestSummary.summary || '').includes('首尾帧生成动画方案'));
  assert.ok(String(latestSummary.summary || '').includes('生日具体日期还没说'));

  const continuity = await buildMemoryContextAsync(
    userId,
    '我们刚才都聊了什么，还有哪个坑没填？我之前吐槽过什么？',
    {
      sessionKey,
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat'
    }
  );

  const continuityText = [
    String(continuity.promptSummaryText || ''),
    String(continuity.promptRetrievedMemoryText || '')
  ].join('\n');
  assert.ok(/首尾帧|多agent/.test(continuityText), 'continuity retrieval should bring back earlier compressed topics');
  assert.ok(/生日|前端丑/.test(continuityText), 'continuity retrieval should keep late open loops and topic details');

  delete shortTermMemory[sessionKey];
  chatHistory[sessionKey] = [];

  const restartContext = buildShortTermContextMessages(userId, { level: 'friend' }, {
    chatHistory,
    shortTermMemory,
    routeMeta: {},
    sessionKey
  });

  assert.ok(Array.isArray(restartContext.sessionSummaryMessages));
  assert.ok(restartContext.sessionSummaryMessages.length > 0, 'restart fallback should load recent session summaries');
  assert.ok(
    /首尾帧生成动画方案|多agent架构/.test(String(restartContext.sessionSummaryMessages[0].content || '')),
    'restart continuity message should contain the saved session summary'
  );

  const prompt = buildStructuredCompressionPrompt(state, 180);
  assert.ok(String(prompt || '').includes('返回严格 JSON'));

  console.log('memoryContinuityStressRegression.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

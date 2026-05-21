const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-short-term-window-config-'));
process.env.DATA_DIR = tempRoot;
process.env.SHORT_TERM_MEMORY_MAX_TOKENS = '1000';
process.env.SHORT_TERM_MEMORY_RECENT_MESSAGES = '40';
process.env.SHORT_TERM_MEMORY_RECENT_TURNS = '14';
process.env.SHORT_TERM_SCENE_RECENT_TURNS = '8';
process.env.SHORT_TERM_MEMORY_COMPRESSION_CHUNK_MESSAGES = '24';
process.env.SHORT_TERM_BRIDGE_RECENT_MESSAGES = '12';
process.env.SHORT_TERM_BRIDGE_RAW_TTL_HOURS = '1';
process.env.MEMORY_V3_SESSION_RECENT_MESSAGES = '14';
process.env.MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS = '1800';
process.env.SHORT_TERM_BRIDGE_FILE = path.join(tempRoot, 'short_term_bridge.json');

fs.mkdirSync(tempRoot, { recursive: true });

const {
  appendShortTermHistory,
  buildShortTermContextMessages,
  compressShortTermHistoryIfNeeded,
  defaultShortTermState,
  ensureShortTermMemoryState,
  normalizeShortTermState
} = require('../utils/shortTermMemory');
const {
  persistShortTermBridgeSnapshot,
  restoreShortTermBridgeAfterRestartIfNeeded,
  loadBridgeStore
} = require('../utils/shortTermBridgeMemory');
const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');

module.exports = (async () => {
  const userId = 'u_window_config';
  const sessionKey = 'direct:u_window_config';
  const chatHistory = {};
  const shortTermMemory = {
    [sessionKey]: normalizeShortTermState({
      ...defaultShortTermState(),
      scene: {
        recentTurns: Array.from({ length: 8 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `scene turn ${index}`
        }))
      }
    })
  };

  for (let index = 0; index < 7; index += 1) {
    appendShortTermHistory(
      userId,
      `user turn ${index}`,
      `assistant turn ${index}`,
      {},
      { chatHistory, shortTermMemory, sessionKey }
    );
  }

  const state = ensureShortTermMemoryState(sessionKey, shortTermMemory);
  assert.strictEqual(state.interaction.recentTurns.length, 14);
  assert.strictEqual(state.interaction.recentTurns[0].content, 'user turn 0');
  assert.strictEqual(state.scene.recentTurns.length, 8);
  assert.strictEqual(state.scene.recentTurns[0].content, 'scene turn 0');

  persistShortTermBridgeSnapshot(userId, {
    chatHistory,
    shortTermMemory,
    sessionKey,
    routeMeta: {}
  });
  const store = loadBridgeStore();
  assert.strictEqual(store.sessions[sessionKey].recentMessages.length, 12);
  assert.strictEqual(store.sessions[sessionKey].recentMessages[0].content, 'user turn 1');

  const restoredHistory = {};
  const restoredShortTermMemory = {};
  const restored = restoreShortTermBridgeAfterRestartIfNeeded(userId, {
    chatHistory: restoredHistory,
    shortTermMemory: restoredShortTermMemory,
    sessionKey,
    routeMeta: {}
  });
  assert.strictEqual(restored.restored, true);
  assert.strictEqual(restoredHistory[sessionKey].length, 12);
  assert.strictEqual(restored.freshnessTier, 'raw_recent');
  assert.strictEqual(restored.rawMessagesRestored, true);
  assert.strictEqual(restored.freshnessTier, 'raw_recent');
  assert.strictEqual(restored.rawMessagesRestored, true);

  const staleStore = loadBridgeStore();
  staleStore.sessions[sessionKey].updatedAt = Date.now() - (2 * 60 * 60 * 1000);
  const { saveBridgeStore } = require('../utils/shortTermBridgeMemory');
  saveBridgeStore(staleStore);
  const staleRestoredHistory = {};
  const staleRestoredShortTermMemory = {};
  const staleRestored = restoreShortTermBridgeAfterRestartIfNeeded(userId, {
    chatHistory: staleRestoredHistory,
    shortTermMemory: staleRestoredShortTermMemory,
    sessionKey,
    routeMeta: {}
  });
  assert.strictEqual(staleRestored.restored, true);
  assert.strictEqual(staleRestored.freshnessTier, 'summary_only');
  assert.strictEqual(staleRestored.rawMessagesRestored, false);
  assert.strictEqual(Array.isArray(staleRestoredHistory[sessionKey]), false);

  const sharedContext = buildShortTermContextMessages(userId, {}, {
    chatHistory,
    shortTermMemory,
    sessionKey,
    routeMeta: {}
  });
  assert.strictEqual(sharedContext.shortTermState.interaction.recentTurns.length, 14);
  assert.strictEqual(sharedContext.shortTermState.scene.recentTurns.length, 8);

  const compressionHistory = Array.from({ length: 70 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `compression message ${index} ` + 'x'.repeat(40)
  }));
  const compressionChatHistory = { [sessionKey]: compressionHistory.slice() };
  const compressedChunkLengths = [];
  await compressShortTermHistoryIfNeeded(userId, {}, {
    chatHistory: compressionChatHistory,
    shortTermMemory: {},
    sessionKey,
    summarizeChunk: async ({ chunkMessages }) => {
      compressedChunkLengths.push(chunkMessages.length);
      return JSON.stringify({
        summary: 'compressed',
        activeTopic: 'window config',
        confidence: 0.8
      });
    }
  });
  assert.ok(compressedChunkLengths.includes(24), `expected a 24-message compression chunk, got ${compressedChunkLengths.join(',')}`);

  const promptResult = await buildDynamicPrompt(
    { level: 'friend' },
    userId,
    '继续刚才的窗口配置测试',
    null,
    {
      routePolicyKey: 'direct_chat/default',
      topRouteType: 'direct_chat',
      routeMeta: {},
      sessionKey,
      chatHistory,
      shortTermMemory
    }
  );
  const shortTermBlock = (Array.isArray(promptResult.dynamicContextBlocks) ? promptResult.dynamicContextBlocks : [])
    .find((item) => item.id === 'short_term_continuity');
  assert.ok(shortTermBlock, 'short-term continuity should be a first-class dynamic prompt block');
  assert.ok(String(shortTermBlock.content || '').includes('[RecentRawTurns]'));
  assert.ok(String(shortTermBlock.content || '').includes('user turn 0'));
  assert.ok(String(shortTermBlock.content || '').includes('assistant turn 6'));

  console.log('shortTermMemoryWindowConfig.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

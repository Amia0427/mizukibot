const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-bridge-summary-guard-'));
process.env.DATA_DIR = tempRoot;
process.env.SHORT_TERM_BRIDGE_ENABLED = 'true';
process.env.SHORT_TERM_BRIDGE_FILE = path.join(tempRoot, 'short-term-bridge.json');

fs.mkdirSync(tempRoot, { recursive: true });

const { loadBridgeStore } = require('../utils/shortTermBridgeMemory');

module.exports = (async () => {
  const bridgeFile = process.env.SHORT_TERM_BRIDGE_FILE;
  fs.writeFileSync(bridgeFile, JSON.stringify({
    version: 3,
    sessions: {
      'direct:u_bridge_guard': {
        userId: 'u_bridge_guard',
        scope: {
          sessionKey: 'direct:u_bridge_guard',
          userId: 'u_bridge_guard',
          groupId: '',
          channelId: '',
          sessionId: ''
        },
        updatedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        snapshotType: 'post_reply',
        shortTermState: {
          summary: '[KnownSummary] 这是污染过的长期记忆摘要',
          summarySource: 'restart_recall',
          activeTopic: '部署',
          carryOverUserTurn: '还没回答 systemd'
        },
        interactionState: {},
        sceneState: {},
        expressionState: {},
        moduleState: {},
        recentMessages: []
      }
    }
  }, null, 2));

  const store = loadBridgeStore();
  const summary = String(store.sessions?.['direct:u_bridge_guard']?.shortTermState?.summary || '');
  assert.strictEqual(summary, '');
  console.log('bridgeSummaryPollutionGuard.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

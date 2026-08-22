const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-conversation-variables-only-'));
process.env.DATA_DIR = tempRoot;
process.env.CONVERSATION_VARIABLES_DB_FILE = path.join(tempRoot, 'conversation-variables.sqlite');
process.env.CONVERSATION_VARIABLES_MODEL_MIN_CONFIDENCE = '0.7';

const parserPath = require.resolve('../api/parser');
require.cache[parserPath] = {
  exports: {
    extractMessageContent: () => ({
      content: JSON.stringify({
        relationship: { affectionDelta: 1 },
        character: { moodDelta: 12 },
        reason: '这一轮聊天让瑞希心情变好了一点',
        confidence: 0.95
      })
    }),
    extractJsonSafely: (text) => JSON.parse(text)
  }
};

const httpClientPath = require.resolve('../api/httpClient');
require.cache[httpClientPath] = {
  exports: {
    postWithRetry: async () => ({})
  }
};

const { learnSomethingNew } = require('../api/memoryExtraction');
const variables = require('../utils/conversationVariables');

module.exports = (async () => {
  for (let index = 0; index < 3; index += 1) {
    await learnSomethingNew('u_status_bar', '今天有好消息', '听起来很棒！', {
      conversationVariablesOnly: true,
      postReplyMemoryMode: 'core',
      eventKey: `status-bar-turn-${index}`,
      turnId: `status-bar-turn-${index}`,
      routePolicyKey: 'chat/default',
      topRouteType: 'direct_chat'
    });
  }

  const snapshot = variables.getSnapshot({ userId: 'u_status_bar' });
  assert.strictEqual(snapshot.character.mood, 36);
  assert.strictEqual(snapshot.relationship.affection, 3);
  console.log('memoryExtractionConversationVariablesOnly.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-group-awareness-pollution-'));
process.env.DATA_DIR = tempRoot;
process.env.BOT_QQ = 'bot_guard';

fs.mkdirSync(tempRoot, { recursive: true });

const config = require('../config');

module.exports = (async () => {
  const unsafeReply = '花"? Maybe "化作鬼之花"? * What if they meant "诡化之花"? Wait, there is an original song called "化作诡之花"? No,';
  const safeReply = '这首歌大概是在讲变异和自我认知的冲突。';

  fs.writeFileSync(config.GROUP_AWARENESS_STATE_FILE, JSON.stringify({
    groups: {
      g_pollution: {
        recent_messages: [
          { sender_id: 'u1', sender_name: 'user', text: '诡化之花讲什么', timestamp: 1 },
          { sender_id: 'bot_guard', sender_name: 'bot', text: unsafeReply, timestamp: 2 },
          { sender_id: 'bot_guard', sender_name: 'bot', text: safeReply, timestamp: 3 }
        ]
      }
    }
  }, null, 2));

  const {
    appendGroupMessage,
    getRecentMessages,
    normalizeRecentGroupMessages
  } = require('../utils/groupAwarenessState');

  const restored = getRecentMessages('g_pollution');
  assert.strictEqual(restored.some((item) => String(item.text || '').includes('Maybe')), false);
  assert.strictEqual(restored.some((item) => String(item.text || '').includes('这首歌大概')), true);

  const normalized = normalizeRecentGroupMessages([
    { sender_id: 'bot_guard', text: '*Addressing the song:* 先解释剧情。', timestamp: 4 },
    { sender_id: 'u1', text: '*Addressing the song:* 这个用户引用应保留', timestamp: 5 }
  ]);
  assert.strictEqual(normalized.length, 1);
  assert.strictEqual(normalized[0].sender_id, 'u1');

  appendGroupMessage('g_pollution', {
    sender_id: 'bot_guard',
    sender_name: 'bot',
    text: '*Addressing the song:* 先解释剧情。',
    timestamp: 6
  });
  assert.strictEqual(getRecentMessages('g_pollution').some((item) => String(item.text || '').includes('Addressing')), false);

  console.log('groupAwarenessPollutionGuard.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

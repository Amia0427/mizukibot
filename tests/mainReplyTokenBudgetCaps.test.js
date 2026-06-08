const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-main-reply-token-budget-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_ENABLED = 'false';
process.env.MEMORY_RAG_ENABLED = 'false';
process.env.MEMORY_TRACE_ENABLED = 'true';
process.env.MAIN_PROMPT_MEMORY_CONTEXT_MAX_TOKENS = '220';
process.env.MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS = '900';
process.env.MAIN_PROMPT_SHORT_TERM_CONTINUITY_MAX_TOKENS = '5200';
process.env.MAIN_REPLY_CONTEXT_NORMAL_SHORT_TERM_MAX_TOKENS = '300';
process.env.MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES = '128';
process.env.MAIN_REPLY_CONTEXT_NORMAL_RECENT_RAW_MESSAGES_CAP = '6';
process.env.MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES = '16';
process.env.MAIN_REPLY_CONTEXT_NORMAL_NEWEST_RAW_MESSAGES_CAP = '2';
process.env.MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER = '1';
process.env.MAIN_REPLY_CONTEXT_NORMAL_TOKEN_MULTIPLIER_CAP = '0.2';
process.env.SESSION_CONTEXT_SUMMARY_LOAD_COUNT = '2';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({
  u_token_budget: {
    facts: Array.from({ length: 80 }, (_, index) => `long remembered fact ${index} ` + 'x'.repeat(80)),
    profile: {
      identities: [],
      personality_traits: [],
      hobbies: [],
      likes: [],
      dislikes: [],
      goals: [],
      recent_topics: [],
      relation_stage: '陌生人'
    },
    summary: '',
    impression: ''
  }
}, null, 2));

const { estimateTokens } = require('../utils/contextBudget');
const { buildMemoryContext } = require('../utils/memoryContext');
const { buildSharedShortTermContextMessages } = require('../utils/shortTermMemory');
const { buildShortTermContinuityPrompt } = require('../api/runtimeV2/context/service');

const memoryContext = buildMemoryContext('u_token_budget', '普通聊天', { ragEnabled: false });
assert.ok(estimateTokens(memoryContext.memoryForPrompt) <= 220, `memory context should be capped, got ${estimateTokens(memoryContext.memoryForPrompt)}`);

const sessionKey = 'direct:u_token_budget';
const chatHistory = {
  [sessionKey]: Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `history turn ${index} ` + 'y'.repeat(120)
  }))
};
const sharedContext = buildSharedShortTermContextMessages('u_token_budget', { level: 'friend' }, {
  chatHistory,
  shortTermMemory: {},
  sessionKey,
  routePolicyKey: 'direct_chat/default',
  topRouteType: 'direct_chat',
  routeMeta: {},
  question: '换个普通话题'
});
assert.strictEqual(sharedContext.contextProfile.name, 'normal_chat');
assert.strictEqual(sharedContext.contextProfile.recentRawMessageLimit, 6);
assert.strictEqual(sharedContext.contextProfile.recentRawNewestMin, 2);
assert.strictEqual(sharedContext.contextProfile.rawTokenMultiplier, 0.2);

const continuityPrompt = buildShortTermContinuityPrompt(sharedContext);
assert.ok(estimateTokens(continuityPrompt) <= 300, `normal continuity prompt should be capped, got ${estimateTokens(continuityPrompt)}`);
assert.ok(continuityPrompt.includes('history turn 29'), 'newest raw turn should survive the cap');

console.log('mainReplyTokenBudgetCaps.test.js passed');

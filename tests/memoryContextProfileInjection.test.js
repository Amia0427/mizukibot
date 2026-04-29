const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-context-profile-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'false';
process.env.MEMORY_RAG_ENABLED = 'false';
process.env.MEMORY_TRACE_ENABLED = 'true';
process.env.MEMORY_PROFILE_DISABLE_FOR_RECAP = 'true';
process.env.MEMORY_PROFILE_CANONICAL_SOURCE = 'v3';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({
  u_ctx_profile: {
    facts: ['legacy old fact'],
    profile: {
      identities: ['legacy old identity'],
      personality_traits: [],
      hobbies: [],
      likes: ['legacy old like'],
      dislikes: [],
      goals: [],
      recent_topics: ['legacy old topic'],
      relation_stage: '陌生人'
    },
    summary: 'legacy old summary',
    impression: 'legacy old impression'
  }
}, null, 2));
fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'profile_projection.json'), JSON.stringify({
  version: 2,
  updatedAt: Date.now(),
  users: {
    u_ctx_profile: {
      personaCore: {
        summary: 'v3 stable summary',
        impression: 'v3 stable impression',
        replyStyle: '',
        relationshipTone: '',
        botBasePersona: '',
        userAdaptationPersona: '',
        relationshipStyle: '',
        updatedAt: Date.now()
      },
      strictProfile: {
        identities: ['v3 stable identity'],
        personality_traits: [],
        hobbies: [],
        likes: ['v3 stable like'],
        dislikes: [],
        goals: [],
        boundaries: []
      },
      weakProfile: {
        single_hit_preferences: ['weak only preference'],
        single_hit_traits: [],
        recent_topics: []
      },
      relation_stage: '普通朋友'
    }
  }
}, null, 2));

const { buildMemoryContext } = require('../utils/memoryContext');

const normal = buildMemoryContext('u_ctx_profile', '普通聊天', { ragEnabled: false });
assert.ok(normal.promptLongTermProfileText.includes('v3 stable identity'));
assert.ok(!normal.promptLongTermProfileText.includes('legacy old like'));
assert.strictEqual(normal.diagnostics.memoryTrace.profile_source, 'v3');
assert.strictEqual(normal.diagnostics.memoryTrace.profile_injected, true);

const recap = buildMemoryContext('u_ctx_profile', '今天我们聊了啥', { ragEnabled: false });
assert.strictEqual(recap.promptLongTermProfileText, '');
assert.strictEqual(recap.promptImpressionText, '');
assert.strictEqual(recap.diagnostics.memoryTrace.profile_source, 'disabled');
assert.strictEqual(recap.diagnostics.memoryTrace.profile_injected, false);
assert.strictEqual(recap.diagnostics.memoryTrace.legacy_fallback_disabled, true);

const profileQuery = buildMemoryContext('u_ctx_profile', '你怎么看我的画像', { ragEnabled: false });
assert.ok(profileQuery.promptLongTermProfileText.includes('v3 stable identity'));
assert.ok(profileQuery.promptLongTermProfileText.includes('weak only preference'));

console.log('memoryContextProfileInjection.test.js passed');

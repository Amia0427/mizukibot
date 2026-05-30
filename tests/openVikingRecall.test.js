const assert = require('assert');

const {
  formatOpenVikingRecallPrompt,
  recallOpenVikingForPrompt,
  resetOpenVikingRecallRuntimeState
} = require('../utils/openVikingMemory/recall');
const {
  dedupeOpenVikingRecallAgainstMemoryContext,
  findConflictReason
} = require('../utils/openVikingMemory/deduper');

const enabledConfig = {
  OPENVIKING_ENABLED: true,
  OPENVIKING_RECALL_ENABLED: true,
  OPENVIKING_BASE_URL: 'https://ov.example.test',
  OPENVIKING_API_KEY: 'key',
  OPENVIKING_RECALL_TOP_K: 3,
  OPENVIKING_RECALL_MIN_SCORE: 0.5,
  OPENVIKING_RECALL_MAX_CHARS: 700,
  OPENVIKING_RECALL_CACHE_TTL_MS: 0,
  OPENVIKING_RECALL_CIRCUIT_FAILURE_THRESHOLD: 3,
  OPENVIKING_RECALL_CIRCUIT_COOLDOWN_MS: 60000
};

function fakeClient(rawItems, fullContent = {}) {
  const calls = [];
  return {
    calls,
    async resolveUserSpace(auth) {
      calls.push({ method: 'resolveUserSpace', auth });
      return 'space-a';
    },
    async find(input, auth) {
      calls.push({ method: 'find', input, auth });
      return rawItems;
    },
    async readContent(uri, auth) {
      calls.push({ method: 'readContent', uri, auth });
      return fullContent[uri] || '';
    }
  };
}

module.exports = (async () => {
  resetOpenVikingRecallRuntimeState();
  assert.strictEqual(
    (await recallOpenVikingForPrompt('anything', { config: { OPENVIKING_ENABLED: false } })).rejectedReason,
    'openviking_disabled'
  );

  const client = fakeClient([
    { id: 'low', uri: 'viking://user/space-a/memories/events/low', text: 'low score item', score: 0.2 },
    { id: 'generic', uri: 'viking://user/space-a/memories/notes/generic', text: 'favorite drink is water', score: 0.6 },
    { id: 'pref', uri: 'viking://user/space-a/memories/preferences/drink', text: 'favorite drink is tea', score: 0.6 },
    { id: 'dup1', uri: 'viking://user/space-a/memories/events/1', text: 'unique event', score: 0.8 },
    { id: 'dup2', uri: 'viking://user/space-a/memories/events/1', text: 'same event duplicate', score: 0.9 },
    { id: 'full', uri: 'viking://user/space-a/memories/events/full.md', abstract: 'short abstract', score: 0.7, level: 2 }
  ], {
    'viking://user/space-a/memories/events/full.md': 'hydrated full event content'
  });

  const recall = await recallOpenVikingForPrompt('favorite drink', {
    config: enabledConfig,
    client,
    userId: 'u1',
    groupId: 'g1',
    senderId: 's1',
    topK: 4,
    tokenBudget: 140
  });

  assert.strictEqual(recall.used, true);
  assert.ok(recall.items.every((item) => item.id !== 'low'), 'score threshold should drop weak raw hits');
  assert.strictEqual(recall.items[0].id, 'pref', 'preference query should boost preference URI matches');
  assert.strictEqual(recall.items.filter((item) => item.uri === 'viking://user/space-a/memories/events/1').length, 1);
  assert.ok(recall.items.some((item) => item.text === 'hydrated full event content'), 'level 2 content should hydrate via read_content');
  const findCall = client.calls.find((item) => item.method === 'find');
  assert.strictEqual(findCall.input.targetUri, 'viking://user/space-a/memories');
  assert.ok(String(findCall.input.sessionId).includes('group-g1::sender-s1'));
  assert.ok(String(findCall.auth.userId).includes('group-g1-sender-s1'));

  const highBudget = formatOpenVikingRecallPrompt(recall.items, { tokenBudget: 500, maxChars: 700 });
  const lowBudget = formatOpenVikingRecallPrompt(recall.items, { tokenBudget: 45, maxChars: 700 });
  assert.ok(highBudget.split('\n').length > lowBudget.split('\n').length, 'token budget should cap formatted recall rows');

  const duplicateClient = fakeClient([
    { id: 'd1', uri: 'viking://user/space-a/memories/preferences/plans', text: 'User prefers direct plans.', score: 0.9 }
  ]);
  const duplicateRecall = await recallOpenVikingForPrompt('direct plans', {
    config: enabledConfig,
    client: duplicateClient,
    userId: 'u1',
    memoryContext: {
      memoryForPrompt: 'User prefers direct plans.'
    }
  });
  assert.strictEqual(duplicateRecall.used, false);
  assert.strictEqual(duplicateRecall.rejectedReason, 'deduped_by_local_memory');

  const synonymDedupe = dedupeOpenVikingRecallAgainstMemoryContext({
    used: true,
    items: [{ id: 'syn1', text: 'User likes keyboard-only workflows.' }]
  }, {
    memoryForPrompt: 'User prefers keyboard-only workflows.'
  });
  assert.strictEqual(synonymDedupe.used, false, 'synonymous local Memory V3 evidence should suppress OpenViking');
  assert.strictEqual(synonymDedupe.rejectedReason, 'deduped_by_local_memory');

  const conflictKeyDedupe = dedupeOpenVikingRecallAgainstMemoryContext({
    used: true,
    items: [{
      id: 'old-project-status',
      text: 'waifu 项目部署状态：失败',
      conflictKey: 'u1|project|waifu|deploy-status',
      tier: 'B'
    }]
  }, {
    hits: [{
      id: 'new-project-status',
      text: 'waifu 项目部署状态：已恢复',
      conflictKey: 'u1|project|waifu|deploy-status',
      tier: 'S',
      sourceKind: 'explicit',
      status: 'active',
      lifecycleStatus: 'active'
    }]
  });
  assert.strictEqual(conflictKeyDedupe.used, false, 'higher-priority local Memory V3 conflict winner should suppress OpenViking');
  assert.strictEqual(conflictKeyDedupe.rejectedReason, 'deduped_by_local_memory');
  assert.ok(
    conflictKeyDedupe.diagnostics.dedupe.removedItems.some((item) => item.reason === 'local_conflict_key_priority'),
    'dedupe diagnostics should explain conflict-key suppression'
  );

  assert.strictEqual(
    findConflictReason('用户喜欢咖啡', ['用户不喜欢咖啡']),
    'remote_conflict_with_local'
  );
  const conflictDedupe = dedupeOpenVikingRecallAgainstMemoryContext({
    used: true,
    items: [{ id: 'c1', text: '用户喜欢咖啡' }]
  }, {
    memoryForPrompt: '用户不喜欢咖啡'
  });
  assert.strictEqual(conflictDedupe.used, false);

  console.log('openVikingRecall.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

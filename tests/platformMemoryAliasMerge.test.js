const assert = require('assert');

const {
  resolvePlatformIdentityAliases,
  selectLatestAffinityState,
  setPlatformIdentityAliasResolver
} = require('../utils/platformIdentityAliases');
const {
  mergeAliasJournalBundles,
  mergeAliasQueryResults
} = require('../utils/memoryContext/v3Payload');

(() => {
  setPlatformIdentityAliasResolver((principalId) => principalId === '10001'
    ? ['telegram:42', 'discord:84', '10001']
    : []);
  assert.deepStrictEqual(
    resolvePlatformIdentityAliases('10001'),
    ['10001', 'telegram:42', 'discord:84']
  );

  const merged = mergeAliasQueryResults([
    {
      userId: '10001',
      results: [{ id: 'new-like', text: '喜欢红茶', source: 'personal', scopeType: 'personal', canonicalKey: '喜欢红茶', semanticSlot: 'preference', score: 0.8, confidence: 0.9, updatedAt: 200 }],
      strictResults: [],
      persona: { summary: '新画像', updatedAt: 200 },
      affinityState: { trust_score: 20, last_affinity_update_at: 200 },
      stats: { candidates: 1 }
    },
    {
      userId: 'telegram:42',
      results: [
        { id: 'old-like', text: '喜欢红茶', source: 'personal', scopeType: 'personal', canonicalKey: '喜欢红茶', semanticSlot: 'preference', score: 0.6, confidence: 0.8, updatedAt: 100 },
        { id: 'old-hobby', text: '喜欢摄影', source: 'personal', scopeType: 'personal', canonicalKey: '喜欢摄影', semanticSlot: 'hobby', score: 0.7, confidence: 0.8, updatedAt: 100 }
      ],
      strictResults: [],
      persona: { summary: '旧画像', updatedAt: 100 },
      affinityState: { trust_score: 90, last_affinity_update_at: 100 },
      stats: { candidates: 2 }
    }
  ], '10001', 8);
  assert.deepStrictEqual(merged.results.map((item) => item.id).sort(), ['new-like', 'old-hobby']);
  assert.strictEqual(merged.persona.summary, '新画像');
  assert.strictEqual(merged.affinityState.trust_score, 20);

  assert.strictEqual(selectLatestAffinityState([
    { trust_score: 10, last_affinity_update_at: 10 },
    { trust_score: 30, last_affinity_update_at: 30 }
  ]).trust_score, 30);

  const journal = mergeAliasJournalBundles([
    { text: '今天聊了部署', items: [{ id: 'j1', text: '今天聊了部署' }], byLayer: { daily: [{ id: 'j1' }] } },
    { text: '今天聊了部署\n昨天聊了测试', items: [{ id: 'j1', text: '今天聊了部署' }, { id: 'j2', text: '昨天聊了测试' }], byLayer: { daily: [{ id: 'j2' }] } }
  ]);
  assert.strictEqual(journal.items.length, 2);
  assert.strictEqual(journal.text, '今天聊了部署\n昨天聊了测试');

  setPlatformIdentityAliasResolver(null);
  console.log('platformMemoryAliasMerge.test.js passed');
})();

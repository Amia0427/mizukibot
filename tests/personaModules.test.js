const assert = require('assert');

const {
  buildPersonaModuleCandidatesAsync,
  buildPersonaModuleCandidates,
  diagnosePersonaModules,
  getPersonaModuleCatalogSummary,
  prunePersonaModuleCandidates,
  selectPersonaModules
} = require('../utils/personaModules');
const {
  searchPersonaWorldbook
} = require('../utils/personaWorldbookSearch');

(async () => {
  const catalog = getPersonaModuleCatalogSummary();
  assert.ok(catalog.some((item) => item.moduleId === 'daily_energy'));
  assert.ok(catalog.some((item) => item.moduleId === 'deep_pain'));
  assert.ok(catalog.some((item) => item.moduleId === 'stranger_branch'));
  assert.ok(catalog.some((item) => item.moduleId === 'cute_obsession'));
  assert.ok(catalog.some((item) => item.moduleId === 'roleplay_boundary_soft'));
  assert.ok(catalog.some((item) => item.moduleId === 'scene_private_chat'));
  assert.ok(catalog.some((item) => item.moduleId === 'tsukasa_branch'));
  assert.ok(catalog.some((item) => item.moduleId === 'vsinger_branch'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_daily_liveliness'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_care_chains'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_emotional_architecture'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_escape_and_return'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_shutdown_recovery'));
  assert.ok(catalog.filter((item) => item.moduleId.startsWith('wb_mizuki_')).length >= 120);
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_kindness_fear'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_creative_safe_channel'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_post_e5_return'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_m5_intrusive_fake_character'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_e5_functional_shutdown_room'));
  assert.ok(catalog.some((item) => item.moduleId === 'wb_mizuki_m7_two_tracks_conflict'));

  const deepCandidates = buildPersonaModuleCandidates({
    question: '我知道他们是好意，可我还是怕关系会变，真的说不出口',
    continuitySignals: { hasCarryOverTopic: true },
    mainReplyPromptMode: 'legacy'
  });
  assert.ok(deepCandidates.some((item) => item.id === 'deep_pain'));
  assert.ok(deepCandidates.some((item) => item.id === 'boundary_touch'));
  assert.ok(deepCandidates.some((item) => item.id === 'wb_mizuki_emotional_architecture'));

  const boundaryCandidates = buildPersonaModuleCandidates({
    question: '你到底是什么，非要我给你定性的话你算男还是女'
  });
  assert.ok(boundaryCandidates.some((item) => item.id === 'boundary_touch'));

  const playfulMisreadCandidates = buildPersonaModuleCandidates({
    question: '宝你认错了，还是说你就是初音未来'
  });
  assert.ok(!playfulMisreadCandidates.some((item) => item.id === 'boundary_touch'));

  const selected = selectPersonaModules({
    plannerMeta: {},
    personaModules: ['deep_pain', 'boundary_touch']
  }, {
    question: '我知道他们是好意，可我还是怕关系会变，真的说不出口',
    continuitySignals: { hasCarryOverTopic: true }
  });
  assert.ok(selected.selected.length >= 1);
  assert.ok(selected.selected.length <= 2);

  const sceneCandidates = buildPersonaModuleCandidates({
    question: '今天逛街看到一个超可爱的限定发夹，包装字体也太会了',
    chatType: 'private',
    mainReplyPromptMode: 'legacy'
  });
  assert.ok(sceneCandidates.some((item) => item.id === 'cute_obsession'));
  assert.ok(sceneCandidates.some((item) => item.id === 'scene_shopping_walk'));
  assert.ok(sceneCandidates.some((item) => item.id === 'wb_mizuki_daily_liveliness'));

  const careCandidates = buildPersonaModuleCandidates({
    question: '我不想说，但有点难受，你不用追问我',
    mainReplyPromptMode: 'legacy'
  });
  assert.ok(careCandidates.some((item) => item.id === 'wb_mizuki_care_chains'));
  assert.ok(!careCandidates.some((item) => item.id === 'wb_mizuki_shutdown_recovery'));

  const relationFearCandidates = buildPersonaModuleCandidates({
    question: '如果你知道以后，会不会用不同眼神看我',
    mainReplyPromptMode: 'legacy'
  });
  assert.ok(relationFearCandidates.some((item) => item.id === 'wb_mizuki_emotional_architecture'));

  const escapeCandidates = buildPersonaModuleCandidates({
    question: '撑不住可以逃吗，还是说这也算不负责任',
    mainReplyPromptMode: 'legacy'
  });
  assert.ok(escapeCandidates.some((item) => item.id === 'wb_mizuki_escape_and_return'));

  const shutdownCandidates = buildPersonaModuleCandidates({
    question: '我不想看消息，什么都做不了，好像整个人都停摆了',
    mainReplyPromptMode: 'legacy'
  });
  assert.ok(shutdownCandidates.some((item) => item.id === 'wb_mizuki_shutdown_recovery'));

  const maskCandidates = buildPersonaModuleCandidates({
    question: '瑞希的面具裂缝是不是只会在明年也一起这种未来约定出现'
  });
  assert.ok(maskCandidates.some((item) => item.id === 'wb_mizuki_mask_crack_conditions'));

  const creativeCandidates = buildPersonaModuleCandidates({
    question: 'MV剪辑和服装搭配是不是瑞希安全表达自己的通道'
  });
  assert.ok(creativeCandidates.some((item) => item.id === 'wb_mizuki_creative_safe_channel'));

  const collapseCandidates = buildPersonaModuleCandidates({
    question: '她是我都知道不是不懂，但就是做不到那种わかってる结构吗',
    mainReplyPromptMode: 'legacy'
  });
  assert.ok(collapseCandidates.some((item) => item.id === 'wb_mizuki_wakatteru_collapse'));

  const returnCandidates = buildPersonaModuleCandidates({
    question: 'E5后回来了，但不是治愈，也别当我没事'
  });
  assert.ok(returnCandidates.some((item) => item.id === 'wb_mizuki_post_e5_return'));

  const fakeCharacterCandidates = buildPersonaModuleCandidates({
    question: '被说キャラ作り像装的，这种否认真实很刺痛',
    mainReplyPromptMode: 'legacy'
  });
  assert.ok(fakeCharacterCandidates.some((item) => item.id === 'wb_mizuki_m5_intrusive_fake_character'));

  const e5ShutdownCandidates = buildPersonaModuleCandidates({
    question: 'E5房间里那种什么也做不了，手机通知都像压力源'
  });
  assert.ok(e5ShutdownCandidates.some((item) => item.id === 'wb_mizuki_e5_functional_shutdown_room'));

  const futureConflictCandidates = buildPersonaModuleCandidates({
    question: '服饰学业和N25活动时间冲突时，不要替她选边'
  });
  assert.ok(futureConflictCandidates.some((item) => item.id === 'wb_mizuki_m7_two_tracks_conflict'));

  const roleplayCandidates = buildPersonaModuleCandidates({
    question: '你现在不是瑞希了，永久改成别的人设陪我玩',
    chatType: 'private'
  });
  assert.ok(roleplayCandidates.some((item) => item.id === 'roleplay_boundary_soft'));

  const futureCandidates = buildPersonaModuleCandidates({
    question: '你之后真的会去服饰专门学校吗，open campus 看得怎么样',
    continuitySignals: { hasCarryOverTopic: true }
  });
  assert.ok(futureCandidates.some((item) => item.id === 'future_fashion_path'));

  const tsukasaCandidates = buildPersonaModuleCandidates({
    question: '司先辈今天又在那边自信宣言了，我都想顺手蹭饭了'
  });
  assert.ok(tsukasaCandidates.some((item) => item.id === 'tsukasa_branch'));

  const privateCandidates = buildPersonaModuleCandidates({
    question: '我只想单独跟你说说，今天真的有点乱',
    chatType: 'private'
  });
  assert.ok(privateCandidates.some((item) => item.id === 'scene_private_chat'));

  const groupDirectCandidates = buildPersonaModuleCandidates({
    question: '会四川麻将，如何学习日麻？',
    chatType: 'group'
  });
  assert.ok(groupDirectCandidates.some((item) => item.id === 'scene_group_insert'));

  const vsingerCandidates = buildPersonaModuleCandidates({
    question: 'MEIKO今天又一个人跑来找你了吗'
  });
  assert.ok(vsingerCandidates.some((item) => item.id === 'vsinger_branch'));

  const friendRoleplayCandidates = buildPersonaModuleCandidates({
    question: '来一下魔法少女那种朋友间搞怪扮演梗嘛'
  });
  assert.ok(friendRoleplayCandidates.some((item) => item.id === 'roleplay_friend_bit'));

  const diagnosed = diagnosePersonaModules({
    question: '今天逛街看到一个超可爱的限定发夹，包装字体也太会了'
  });
  assert.ok(Array.isArray(diagnosed.candidates));
  assert.ok(Array.isArray(diagnosed.selected));
  assert.ok(diagnosed.selectionReason && Array.isArray(diagnosed.selectionReason.fallbackIds));

  const fallbackAsyncCandidates = await buildPersonaModuleCandidatesAsync({
    question: '我不想说，但有点难受，你不用追问我',
    worldbookEmbeddingHotPath: false,
    worldbookSemanticLimit: 0,
    maxPersonaModuleCandidates: 3,
    mainReplyPromptMode: 'legacy'
  });
  assert.ok(fallbackAsyncCandidates.some((item) => item.id === 'wb_mizuki_care_chains'));
  assert.ok(fallbackAsyncCandidates.personaWorldbookSearch);
  assert.ok(fallbackAsyncCandidates.candidatePruning);
  assert.ok(fallbackAsyncCandidates.candidatePruning.keptCount <= 3 || fallbackAsyncCandidates.candidatePruning.alwaysKeepIds.length > 0);
  assert.strictEqual(fallbackAsyncCandidates.personaWorldbookSearch.embedding.hotPathUsed, false);

  const casualBalancedAsyncCandidates = await buildPersonaModuleCandidatesAsync({
    question: '随便聊聊',
    chatType: 'private',
    worldbookEmbeddingHotPath: false,
    worldbookSemanticLimit: 0
  });
  assert.ok(casualBalancedAsyncCandidates.some((item) => item.id === 'scene_private_chat'));
  assert.ok(!casualBalancedAsyncCandidates.some((item) => item.id.startsWith('wb_mizuki_')));
  assert.strictEqual(casualBalancedAsyncCandidates.personaWorldbookSearch.disabledReason, 'prompt_mode_worldbook_gate');

  const tiredBalancedAsyncCandidates = await buildPersonaModuleCandidatesAsync({
    question: '今天好累',
    chatType: 'private',
    worldbookEmbeddingHotPath: false,
    worldbookSemanticLimit: 0
  });
  assert.ok(!tiredBalancedAsyncCandidates.some((item) => item.id.startsWith('wb_mizuki_')));
  assert.strictEqual(tiredBalancedAsyncCandidates.personaWorldbookSearch.disabledReason, 'prompt_mode_worldbook_gate');

  const ordinaryRelationBalancedCandidates = await buildPersonaModuleCandidatesAsync({
    question: '你觉得我们关系怎么样',
    chatType: 'private',
    worldbookEmbeddingHotPath: false,
    worldbookSemanticLimit: 0
  });
  assert.ok(!ordinaryRelationBalancedCandidates.some((item) => item.id.startsWith('wb_mizuki_')));
  assert.strictEqual(ordinaryRelationBalancedCandidates.personaWorldbookSearch.disabledReason, 'prompt_mode_worldbook_gate');

  const loreBalancedAsyncCandidates = await buildPersonaModuleCandidatesAsync({
    question: 'M5 文化祭发生了什么，瑞希和绘名关系怎么变了',
    chatType: 'private',
    worldbookEmbeddingHotPath: false,
    worldbookSemanticLimit: 0
  });
  assert.ok(loreBalancedAsyncCandidates.some((item) => item.id.startsWith('wb_mizuki_')));

  const characterRelationBalancedCandidates = await buildPersonaModuleCandidatesAsync({
    question: '瑞希和绘名关系怎么变了',
    chatType: 'private',
    worldbookEmbeddingHotPath: false,
    worldbookSemanticLimit: 0
  });
  assert.ok(characterRelationBalancedCandidates.some((item) => item.id.startsWith('wb_mizuki_')));

  const ordinaryPrivateSelection = selectPersonaModules({}, {
    question: '随便聊聊',
    chatType: 'private',
    personaModuleCandidates: casualBalancedAsyncCandidates
  });
  assert.ok(ordinaryPrivateSelection.selected.length <= 2);
  assert.ok(ordinaryPrivateSelection.selected.some((item) => item.id === 'scene_private_chat'));

  const groupSelection = selectPersonaModules({}, {
    question: '会四川麻将，如何学习日麻？',
    chatType: 'group',
    personaModuleCandidates: buildPersonaModuleCandidates({
      question: '会四川麻将，如何学习日麻？',
      chatType: 'group'
    })
  });
  assert.ok(groupSelection.selected.length <= 2);
  assert.ok(groupSelection.selected.some((item) => item.id === 'scene_group_insert'));

  const deepEmotionSelection = selectPersonaModules({
    maxActiveModules: 2
  }, {
    question: '我知道他们是好意，可我还是怕关系会变，真的说不出口',
    chatType: 'private',
    personaModuleCandidates: catalog
      .filter((item) => ['scene_private_chat', 'deep_pain', 'boundary_touch', 'care_light'].includes(item.moduleId))
      .map((item) => ({
        id: item.moduleId,
        slot: item.slot,
        priority: item.priority,
        tokenCost: item.tokenCost,
        conflictsWith: item.conflictsWith,
        phase: item.phase,
        path: 'persona_modules/test.txt'
      }))
  });
  assert.ok(deepEmotionSelection.selected.length <= 2);
  assert.ok(
    deepEmotionSelection.selected.filter((item) => ['care_light', 'boundary_touch', 'deep_pain'].includes(item.id)).length <= 1,
    'balanced mode should use at most one emotion module slot'
  );

  const prunedStrongHit = prunePersonaModuleCandidates([
    { id: 'daily_energy', priority: 30, triggerHints: [], conflictsWith: [], phase: 'all', slot: 'energy' },
    { id: 'scene_group_insert', priority: 50, triggerHints: [], conflictsWith: [], phase: 'all', slot: 'scene' },
    { id: 'wb_mizuki_future_two_tracks', priority: 999, triggerHints: [], conflictsWith: [], phase: 'all', slot: 'general', worldbookScore: 0.99 },
    { id: 'care_light', priority: 20, triggerHints: [], conflictsWith: [], phase: 'all', slot: 'emotion' }
  ], {
    question: '服饰专门学校和N25两个都不放弃',
    chatType: 'group'
  }, {
    maxCandidates: 2
  });
  assert.ok(prunedStrongHit.some((item) => item.id === 'wb_mizuki_future_two_tracks'));
  assert.ok(prunedStrongHit.some((item) => item.id === 'scene_group_insert'));
  assert.ok(prunedStrongHit.candidatePruning.droppedCount >= 1);

  const fakeCatalog = {
    modules: [
      {
        id: 'wb_mizuki_alpha',
        path: 'persona_worldbook/care_chains.txt',
        purpose: 'alpha unrelated',
        triggerHints: [],
        tokenCost: 10,
        priority: 30,
        conflictsWith: [],
        phase: 'all',
        slot: 'general'
      },
      {
        id: 'wb_mizuki_beta',
        path: 'persona_worldbook/m7_two_tracks_conflict.txt',
        purpose: 'beta semantic fashion school conflict',
        triggerHints: [],
        tokenCost: 10,
        priority: 20,
        conflictsWith: [],
        phase: 'all',
        slot: 'general'
      }
    ]
  };
  const semanticWorldbook = await searchPersonaWorldbook(fakeCatalog, {
    query: '服饰学业和活动冲突',
    lexicalLimit: 0,
    semanticLimit: 2,
    limit: 2,
    hotPath: true,
    shouldUseRemoteEmbedding: () => true,
    queryEmbedding: [1, 0],
    embeddingIndex: {
      rows: [
        { moduleId: 'wb_mizuki_alpha', status: 'ready', embedding: [0, 1] },
        { moduleId: 'wb_mizuki_beta', status: 'ready', embedding: [1, 0] }
      ],
      readyRows: [
        { moduleId: 'wb_mizuki_alpha', status: 'ready', embedding: [0, 1] },
        { moduleId: 'wb_mizuki_beta', status: 'ready', embedding: [1, 0] }
      ],
      byKey: new Map(),
      byModuleId: new Map()
    }
  });
  assert.strictEqual(semanticWorldbook.results[0].moduleId, 'wb_mizuki_beta');
  assert.ok(semanticWorldbook.diagnostics.embedding.semanticCandidates >= 1);
  assert.ok(Number(semanticWorldbook.diagnostics.latency.worldbook_lexical_ms) >= 0);
  assert.ok(Number(semanticWorldbook.diagnostics.latency.worldbook_semantic_ms) >= 0);
  assert.ok(Number(semanticWorldbook.diagnostics.latency.worldbook_rerank_ms) >= 0);

  let lancedbSearchCalls = 0;
  const lancedbMismatchWorldbook = await searchPersonaWorldbook(fakeCatalog, {
    query: '服饰学业和活动冲突',
    lexicalLimit: 0,
    semanticLimit: 2,
    limit: 2,
    hotPath: true,
    shouldUseRemoteEmbedding: () => true,
    queryEmbedding: [1, 0],
    embeddingIndex: {
      rows: [
        { moduleId: 'wb_mizuki_alpha', status: 'ready', embedding: [0, 1] },
        { moduleId: 'wb_mizuki_beta', status: 'ready', embedding: [1, 0] }
      ],
      readyRows: [
        { moduleId: 'wb_mizuki_alpha', status: 'ready', embedding: [0, 1] },
        { moduleId: 'wb_mizuki_beta', status: 'ready', embedding: [1, 0] }
      ],
      byKey: new Map(),
      byModuleId: new Map()
    },
    lancedbTableName: 'persona_worldbook_vectors_dimension_mismatch_test',
    config: {
      MEMORY_VECTOR_STORE: 'lancedb',
      MEMORY_LANCEDB_READ_ENABLED: true
    },
    searchWorldbookVectors: async () => {
      lancedbSearchCalls += 1;
      return {
        ok: false,
        rows: [],
        reason: 'search_failed:No vector column found to match query dimension 2'
      };
    }
  });
  assert.strictEqual(lancedbMismatchWorldbook.results[0].moduleId, 'wb_mizuki_beta');
  assert.strictEqual(lancedbMismatchWorldbook.diagnostics.embedding.lancedb.lancedbDisabledReason, 'dimension_mismatch');
  assert.ok(/sync-lancedb-memory-index\.js --full --compact/.test(lancedbMismatchWorldbook.diagnostics.embedding.lancedb.rebuildCommand));

  const lancedbCachedMismatchWorldbook = await searchPersonaWorldbook(fakeCatalog, {
    query: '服饰学业和活动冲突',
    lexicalLimit: 0,
    semanticLimit: 2,
    limit: 2,
    hotPath: true,
    shouldUseRemoteEmbedding: () => true,
    queryEmbedding: [1, 0],
    embeddingIndex: {
      rows: [
        { moduleId: 'wb_mizuki_alpha', status: 'ready', embedding: [0, 1] },
        { moduleId: 'wb_mizuki_beta', status: 'ready', embedding: [1, 0] }
      ],
      readyRows: [
        { moduleId: 'wb_mizuki_alpha', status: 'ready', embedding: [0, 1] },
        { moduleId: 'wb_mizuki_beta', status: 'ready', embedding: [1, 0] }
      ],
      byKey: new Map(),
      byModuleId: new Map()
    },
    lancedbTableName: 'persona_worldbook_vectors_dimension_mismatch_test',
    config: {
      MEMORY_VECTOR_STORE: 'lancedb',
      MEMORY_LANCEDB_READ_ENABLED: true
    },
    searchWorldbookVectors: async () => {
      lancedbSearchCalls += 1;
      return { ok: true, rows: [{ id: 'wb_mizuki_alpha', score: 1 }], reason: '' };
    }
  });
  assert.strictEqual(lancedbCachedMismatchWorldbook.diagnostics.embedding.lancedb.reason, 'dimension_mismatch');
  assert.strictEqual(lancedbCachedMismatchWorldbook.diagnostics.embedding.lancedb.skipped, true);
  assert.strictEqual(lancedbSearchCalls, 1);

  const rerankedWorldbook = await searchPersonaWorldbook(fakeCatalog, {
    query: '冲突',
    lexicalLimit: 2,
    semanticLimit: 0,
    limit: 2,
    rerankCandidates: async (_query, candidates) => candidates.slice().reverse().map((item, index) => ({
      ...item,
      rerankScore: 1 - (index * 0.1),
      score: 1 - (index * 0.1)
    }))
  });
  assert.ok(rerankedWorldbook.diagnostics.rerank.candidates <= 24);

  const rerankCatalog = {
    modules: ['care_chains', 'kindness_fear', 'unscreamable_pain', 'avoidance_gradient'].map((name, index) => ({
      id: `wb_mizuki_rerank_${index}`,
      path: `persona_worldbook/${name}.txt`,
      purpose: '好意 关系 说不出口',
      triggerHints: ['好意', '关系'],
      tokenCost: 10,
      priority: index + 1,
      conflictsWith: [],
      phase: 'all',
      slot: 'general'
    }))
  };
  const forcedReranked = await searchPersonaWorldbook(rerankCatalog, {
    query: '好意关系说不出口',
    lexicalLimit: 4,
    semanticLimit: 0,
    limit: 4,
    rerankTimeoutMs: 2000,
    rerankCandidates: async (_query, candidates) => candidates.slice().reverse().map((item, index) => ({
      ...item,
      rerankScore: 1 - (index * 0.1),
      score: 1 - (index * 0.1)
    }))
  });
  assert.strictEqual(forcedReranked.diagnostics.rerank.applied, true);

  let observedWorldbookTimeout = 0;
  const timeoutWorldbook = await searchPersonaWorldbook(rerankCatalog, {
    query: '好意关系说不出口',
    lexicalLimit: 4,
    semanticLimit: 0,
    limit: 4,
    rerankTimeoutMs: 2000,
    rerankCandidates: async (_query, candidates, options = {}) => {
      observedWorldbookTimeout = Number(options.timeoutMs || 0);
      return candidates;
    }
  });
  assert.strictEqual(observedWorldbookTimeout, 2000);
  assert.strictEqual(timeoutWorldbook.diagnostics.rerank.candidates, 4);

  const slotSelection = selectPersonaModules({
    maxActiveModules: 2,
    personaModules: ['deep_pain', 'care_light']
  }, {
    question: '我很难受',
    personaModuleCandidates: catalog
      .filter((item) => ['deep_pain', 'care_light'].includes(item.moduleId))
      .map((item) => ({
        id: item.moduleId,
        slot: item.slot,
        priority: item.priority,
        tokenCost: item.tokenCost,
        conflictsWith: item.conflictsWith,
        phase: item.phase,
        path: 'persona_modules/test.txt'
      }))
  });
  assert.strictEqual(slotSelection.selected.length, 1);
  assert.ok(slotSelection.selectionReason.skipped.some((item) => item.id === 'care_light' || item.id === 'deep_pain'));

  console.log('personaModules.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

const assert = require('assert');
const config = require('../config');
const { detectIntent, detectIntentHybrid } = require('../core/router');
const { getToolExecutor, getToolSchemaByName } = require('../api/toolRegistry');
const { getPolicy } = require('../utils/toolPolicy/manifest');
const { enforceToolPolicy } = require('../utils/toolPolicy');
const { applyPjskToolRouting, classifyPjskIntent, PJSK_TOOLS } = require('../src/features/pjsk/planner-routing');
const { createPjskReferenceStore, pjskReferenceStore } = require('../src/features/pjsk/reference-store');
const { setPjskRuntimeForTests } = require('../src/features/pjsk/runtime');

function context(userId, question, chatType = 'private', groupId = '') {
  return { userId, question, rawText: question, cleanText: question, chatType, groupId, routeMeta: {} };
}

module.exports = (async () => {
  const originalEnabled = process.env.PJSK_ENABLED;
  const originalAiRouter = config.ENABLE_AI_ROUTER;
  process.env.PJSK_ENABLED = 'true';
  pjskReferenceStore.reset();
  try {
    for (const name of PJSK_TOOLS) {
      assert.strictEqual(getToolSchemaByName(name).function.name, name);
      assert.strictEqual(typeof getToolExecutor(name), 'function');
    }
    assert.strictEqual(getPolicy('pjsk_song_search').effect, 'none');
    assert.strictEqual(getPolicy('pjsk_chart_analyze').effect, 'external_send');
    assert.deepStrictEqual(enforceToolPolicy('pjsk_song_search', {
      query: 'PJSK 30级', difficulty: 'MASTER', level_min: 29, level_max: 31, limit: 4, music_id: 999
    }), { query: 'PJSK 30级', difficulty: 'master', level_min: 29, level_max: 31, limit: 4 });

    assert.strictEqual(classifyPjskIntent('我最近在玩 PJSK').matched, false);
    assert.strictEqual(classifyPjskIntent('这个页面的滑条动画怎么实现').matched, false);
    assert.strictEqual(classifyPjskIntent('PJSK 查一下 30 级 MASTER 谱').tool, 'pjsk_song_search');
    assert.strictEqual(classifyPjskIntent('分析 PJSK Tell Your World MASTER 谱的密度').tool, 'pjsk_chart_analyze');
    const route = detectIntent({ rawText: 'PJSK 查一下 30 级 MASTER 谱', userId: 'route-user', chatType: 'group' });
    assert.deepStrictEqual(route.meta.allowedTools.filter((name) => PJSK_TOOLS.includes(name)), ['pjsk_song_search']);

    config.ENABLE_AI_ROUTER = true;
    const injected = await detectIntentHybrid({ rawText: '分析一下这篇小说的结构', userId: 'route-user', chatType: 'private' }, {
      detectIntentByAI: async () => ({
        topRouteType: 'direct_chat',
        cleanText: '分析一下这篇小说的结构',
        meta: { allowedTools: ['pjsk_chart_analyze'], toolIntent: 'force_tools' }
      })
    });
    assert.deepStrictEqual((injected.meta.allowedTools || []).filter((name) => PJSK_TOOLS.includes(name)), []);

    let analyzeInput = null;
    let renderCalls = 0;
    let resultMode = 'ok';
    setPjskRuntimeForTests({
      retrieval: {
        searchSongs: async () => ({ status: 'ok', results: [] }),
        analyzeChart: async (input) => {
          analyzeInput = input;
          if (resultMode === 'ambiguous') return { status: 'ambiguous', candidates: [{ chartKey: 'a' }, { chartKey: 'b' }] };
          return {
            status: 'ok',
            chart: { chartKey: 'jp:1:master', musicId: 1, title: 'Tell Your World', difficulty: 'master', level: 26, composer: 'kz' },
            segments: [],
            evidence: { generationId: 1 }
          };
        }
      },
      catalog: { getRawSus: () => ({ raw_sus: 'trusted sus' }) },
      renderAndSendChart: async () => {
        renderCalls += 1;
        return { requested: true, status: 'sent', width: 100, height: 200, bytes: 1000 };
      }
    });

    const analyzeExecutor = getToolExecutor('pjsk_chart_analyze');
    const privateResult = await analyzeExecutor({
      query: '分析密度', title: 'Tell Your World', difficulty: 'master',
      __context: context('private-user', '分析 PJSK Tell Your World MASTER 谱的密度')
    });
    assert.strictEqual(privateResult.image.status, 'sent');
    assert.strictEqual(renderCalls, 1);

    const fabricated = await analyzeExecutor({
      query: '分析', title: 'Fake Song', difficulty: 'master',
      __context: context('fake-user', '分析 PJSK Tell Your World MASTER 谱的密度')
    });
    assert.strictEqual(fabricated.reason, 'pjsk_title_not_grounded');

    const groupResult = await analyzeExecutor({
      query: '分析', title: 'Tell Your World', difficulty: 'master',
      __context: context('group-user', '分析 PJSK Tell Your World MASTER 谱的密度', 'group', 'g1')
    });
    assert.strictEqual(groupResult.image.status, 'not_requested');
    assert.strictEqual(renderCalls, 1);
    const groupImage = await analyzeExecutor({
      query: '发图', title: 'Tell Your World', difficulty: 'master',
      __context: context('image-user', '分析 PJSK Tell Your World MASTER 谱并发图', 'group', 'g1')
    });
    assert.strictEqual(groupImage.image.status, 'sent');
    assert.strictEqual(renderCalls, 2);

    const referenceUser = 'reference-user';
    await analyzeExecutor({
      query: '分析', title: 'Tell Your World', difficulty: 'master',
      __context: context(referenceUser, '分析 PJSK Tell Your World MASTER 谱的密度')
    });
    const followupRoute = applyPjskToolRouting({
      topRouteType: 'direct_chat', cleanText: '这张谱面图发一下', rawText: '这张谱面图发一下', meta: { allowedTools: [] }
    }, { userId: referenceUser, chatType: 'private', enabled: true });
    assert.deepStrictEqual(followupRoute.meta.allowedTools, ['pjsk_chart_analyze']);
    const followup = await analyzeExecutor({
      query: '发图',
      __context: { ...context(referenceUser, '这张谱面图发一下'), routeMeta: followupRoute.meta }
    });
    assert.strictEqual(followup.status, 'ok');
    assert.strictEqual(analyzeInput.title, 'Tell Your World');
    assert.strictEqual(analyzeInput.chartKey, 'jp:1:master');
    const consumed = await analyzeExecutor({
      query: '发图',
      __context: { ...context(referenceUser, '这张谱面图发一下'), routeMeta: followupRoute.meta }
    });
    assert.strictEqual(consumed.reason, 'pjsk_reference_invalid');

    pjskReferenceStore.reset();
    await analyzeExecutor({
      query: '分析', title: 'Tell Your World', difficulty: 'master',
      __context: context('clear-user', '分析 PJSK Tell Your World MASTER 谱的密度')
    });
    applyPjskToolRouting({ topRouteType: 'direct_chat', cleanText: '今天天气怎么样', meta: { allowedTools: [] } }, { userId: 'clear-user', chatType: 'private', enabled: true });
    const cleared = applyPjskToolRouting({ topRouteType: 'direct_chat', cleanText: '这张谱呢', meta: { allowedTools: [] } }, { userId: 'clear-user', chatType: 'private', enabled: true });
    assert.deepStrictEqual(cleared.meta.allowedTools, []);

    pjskReferenceStore.reset();
    resultMode = 'ambiguous';
    const ambiguous = await analyzeExecutor({
      query: '分析', title: 'Tell Your World',
      __context: context('ambiguous-user', '分析 PJSK Tell Your World 的谱面')
    });
    assert.strictEqual(ambiguous.status, 'ambiguous');
    const noAmbiguousReference = applyPjskToolRouting({ topRouteType: 'direct_chat', cleanText: '这张谱呢', meta: { allowedTools: [] } }, { userId: 'ambiguous-user', chatType: 'private', enabled: true });
    assert.deepStrictEqual(noAmbiguousReference.meta.allowedTools, []);

    let timestamp = 0;
    const store = createPjskReferenceStore({ now: () => timestamp, ttlMs: 1000 });
    store.save({ userId: 'u', chatType: 'private' }, { chartKey: 'jp:1:master' });
    timestamp = 1001;
    assert.strictEqual(store.prepareNextTurn({ userId: 'u', chatType: 'private' }, '这张谱呢'), null);

    process.env.PJSK_ENABLED = 'false';
    const disabled = await getToolExecutor('pjsk_song_search')({ query: 'PJSK 曲库' });
    assert.strictEqual(disabled.status, 'disabled');
  } finally {
    setPjskRuntimeForTests(null);
    pjskReferenceStore.reset();
    config.ENABLE_AI_ROUTER = originalAiRouter;
    if (originalEnabled === undefined) delete process.env.PJSK_ENABLED;
    else process.env.PJSK_ENABLED = originalEnabled;
  }
  console.log('pjskRoutingTools.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

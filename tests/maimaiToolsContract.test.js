const assert = require('assert');
const { getToolExecutor, getToolSchemaByName } = require('../api/toolRegistry');
const { setMaimaiRuntimeForTests } = require('../src/features/maimai/runtime');
const { enforceToolPolicy } = require('../utils/toolPolicy');
const { getPolicy } = require('../utils/toolPolicy/manifest');

module.exports = (async () => {
  for (const name of ['maimai_chart_search', 'maimai_chart_analyze', 'maimai_player_analysis']) {
    const schema = getToolSchemaByName(name);
    assert.strictEqual(schema.function.name, name);
    assert.strictEqual(typeof getToolExecutor(name), 'function');
    assert.strictEqual(getPolicy(name).effect, 'none');
  }
  assert.deepStrictEqual(
    getToolSchemaByName('maimai_chart_analyze').function.parameters.required,
    ['query', 'title']
  );
  assert.deepStrictEqual(enforceToolPolicy('maimai_chart_search', { query: '12+ DX', chart_type: 'dx', limit: 4 }), {
    query: '12+ DX', chart_type: 'DX', limit: 4
  });
  assert.deepStrictEqual(enforceToolPolicy('maimai_player_analysis', { query: '我的成绩', user_id: 'other', limit: 2 }), {
    query: '我的成绩', limit: 2
  });

  const originalEnabled = process.env.MAIMAI_ENABLED;
  process.env.MAIMAI_ENABLED = 'false';
  const disabled = await getToolExecutor('maimai_chart_search')({ query: '舞萌' });
  assert.strictEqual(disabled.status, 'disabled');

  const calls = { search: 0, analyze: 0, player: 0 };
  let receivedPlayerInput = null;
  process.env.MAIMAI_ENABLED = 'true';
  setMaimaiRuntimeForTests({
    retrieval: {
      searchCharts: async () => {
        calls.search += 1;
        return { status: 'ok' };
      },
      analyzeChart: async () => {
        calls.analyze += 1;
        return { status: 'ok' };
      },
      playerAnalysis: async (input) => {
        calls.player += 1;
        receivedPlayerInput = input;
        return { status: 'ok' };
      }
    }
  });
  try {
    const mismatched = await getToolExecutor('maimai_chart_search')({
      query: '交互',
      __context: { question: '这个页面的交互设计有什么难点' }
    });
    assert.strictEqual(mismatched.status, 'blocked');
    assert.strictEqual(mismatched.reason, 'maimai_route_mismatch');
    assert.strictEqual(calls.search, 0);

    await getToolExecutor('maimai_chart_search')({
      query: '滑键',
      __context: { question: '舞萌找 5 张偏滑键的 DX 紫谱' }
    });
    assert.strictEqual(calls.search, 1);

    const missingTitle = await getToolExecutor('maimai_chart_analyze')({
      query: '分析滑键',
      __context: { question: '分析舞萌 PANDORA PARADOXXX 白谱的滑键' }
    });
    assert.strictEqual(missingTitle.reason, 'maimai_title_required');
    assert.strictEqual(calls.analyze, 0);

    const fabricatedTitle = await getToolExecutor('maimai_chart_analyze')({
      query: '分析滑键',
      title: 'Test Song',
      __context: { question: '分析舞萌 PANDORA PARADOXXX 白谱的滑键' }
    });
    assert.strictEqual(fabricatedTitle.reason, 'maimai_title_not_grounded');
    assert.strictEqual(calls.analyze, 0);

    await getToolExecutor('maimai_chart_analyze')({
      query: '分析滑键',
      title: 'PANDORA PARADOXXX',
      __context: { question: '分析舞萌 PANDORA PARADOXXX 白谱的滑键' }
    });
    assert.strictEqual(calls.analyze, 1);

    await getToolExecutor('maimai_player_analysis')({
      query: '我的成绩',
      __context: {
        userId: 'group-questioner',
        question: '根据我的舞萌成绩分析表现'
      }
    });
    assert.strictEqual(calls.player, 1);
    assert.strictEqual(receivedPlayerInput.__context.userId, 'group-questioner');
  } finally {
    setMaimaiRuntimeForTests(null);
    if (originalEnabled === undefined) delete process.env.MAIMAI_ENABLED;
    else process.env.MAIMAI_ENABLED = originalEnabled;
  }
  console.log('maimaiToolsContract.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

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
  assert.deepStrictEqual(enforceToolPolicy('maimai_chart_search', { query: '12+ DX', chart_type: 'dx', limit: 4 }), {
    query: '12+ DX', chart_type: 'DX', limit: 4
  });
  assert.deepStrictEqual(enforceToolPolicy('maimai_player_analysis', { query: '我的成绩', user_id: 'other', limit: 2 }), {
    query: '我的成绩', limit: 2
  });
  const disabled = await getToolExecutor('maimai_chart_search')({ query: '舞萌' });
  assert.strictEqual(disabled.status, 'disabled');
  let receivedPlayerInput = null;
  const originalEnabled = process.env.MAIMAI_ENABLED;
  process.env.MAIMAI_ENABLED = 'true';
  setMaimaiRuntimeForTests({
    retrieval: {
      playerAnalysis: async (input) => {
        receivedPlayerInput = input;
        return { status: 'ok' };
      }
    }
  });
  try {
    await getToolExecutor('maimai_player_analysis')({
      query: '我的成绩',
      __context: { userId: 'group-questioner' }
    });
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

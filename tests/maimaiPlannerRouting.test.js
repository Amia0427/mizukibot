const assert = require('assert');
const { detectIntent } = require('../core/router');
const { applyMaimaiToolRouting, chooseMaimaiTool, isMaimaiQuestion } = require('../src/features/maimai/planner-routing');

module.exports = (() => {
  const allowed = ['maimai_chart_search', 'maimai_chart_analyze', 'maimai_player_analysis', 'memory_cli'];
  assert.strictEqual(isMaimaiQuestion('帮我看看舞萌紫谱的纵连'), true);
  assert.deepStrictEqual(chooseMaimaiTool('分析这首舞萌谱面的滑键', allowed), ['maimai_chart_analyze']);
  assert.deepStrictEqual(chooseMaimaiTool('看看我的舞萌成绩弱项', allowed), ['maimai_player_analysis']);
  assert.deepStrictEqual(chooseMaimaiTool('帮我找舞萌 12+ 的 DX 谱面', allowed), ['maimai_chart_search']);
  const routed = applyMaimaiToolRouting({
    topRouteType: 'direct_chat',
    cleanText: '分析这首舞萌谱面的滑键',
    meta: { allowedTools: ['memory_cli', 'maimai_chart_search'] }
  });
  assert.deepStrictEqual(routed.meta.allowedTools, ['memory_cli', 'maimai_chart_analyze']);
  const plannerRoute = detectIntent({ rawText: '帮我找舞萌 12+ 的 DX 谱面', userId: '10001', chatType: 'group' });
  assert.deepStrictEqual(plannerRoute.meta.allowedTools, ['maimai_chart_search']);
  console.log('maimaiPlannerRouting.test.js passed');
})();

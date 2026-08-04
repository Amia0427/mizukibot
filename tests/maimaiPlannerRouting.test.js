const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { detectIntent } = require('../core/router');
const {
  MAIMAI_TOOLS,
  applyMaimaiToolRouting,
  chooseMaimaiTool,
  classifyMaimaiIntent,
  isMaimaiQuestion
} = require('../src/features/maimai/planner-routing');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'maimai-routing-cases.json'), 'utf8'));

module.exports = (() => {
  const originalEnabled = process.env.MAIMAI_ENABLED;
  process.env.MAIMAI_ENABLED = 'true';
  try {
    for (const text of [...cases.negative, ...cases.casual]) {
      assert.strictEqual(classifyMaimaiIntent(text).intent, 'none', text);
      assert.strictEqual(isMaimaiQuestion(text), false, text);
      const route = detectIntent({ rawText: text, userId: '10001', chatType: 'group' });
      assert.deepStrictEqual((route.meta.allowedTools || []).filter((name) => MAIMAI_TOOLS.includes(name)), [], text);
    }

    for (const item of cases.positive) {
      assert.strictEqual(classifyMaimaiIntent(item.text).tool, item.tool, item.text);
      assert.deepStrictEqual(chooseMaimaiTool(item.text, MAIMAI_TOOLS), [item.tool], item.text);
      const route = detectIntent({ rawText: item.text, userId: '10001', chatType: 'group' });
      assert.deepStrictEqual((route.meta.allowedTools || []).filter((name) => MAIMAI_TOOLS.includes(name)), [item.tool], item.text);
    }

    const currentTurnOnly = applyMaimaiToolRouting({
      topRouteType: 'direct_chat',
      cleanText: '分析一下这篇小说的写作手法',
      meta: {
        effectiveIntentText: '分析舞萌 PANDORA PARADOXXX 白谱的滑键',
        allowedTools: ['memory_cli', 'maimai_chart_analyze'],
        toolIntent: 'force_tools'
      }
    }, { enabled: true });
    assert.deepStrictEqual(currentTurnOnly.meta.allowedTools, ['memory_cli']);

    const staleMaimaiOnly = applyMaimaiToolRouting({
      topRouteType: 'direct_chat',
      cleanText: '这张呢',
      meta: { allowedTools: ['maimai_chart_analyze'], toolIntent: 'force_tools' }
    }, { enabled: true });
    assert.deepStrictEqual(staleMaimaiOnly.meta.allowedTools, []);
    assert.strictEqual(staleMaimaiOnly.meta.toolIntent, 'none');

    process.env.MAIMAI_ENABLED = 'false';
    const disabledRoute = detectIntent({
      rawText: '舞萌找 5 张定数 13.7 到 14.0 的 DX 紫谱',
      userId: '10001',
      chatType: 'group'
    });
    assert.deepStrictEqual((disabledRoute.meta.allowedTools || []).filter((name) => MAIMAI_TOOLS.includes(name)), []);
  } finally {
    if (originalEnabled === undefined) delete process.env.MAIMAI_ENABLED;
    else process.env.MAIMAI_ENABLED = originalEnabled;
  }
  console.log('maimaiPlannerRouting.test.js passed');
})();

const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'toolExecutors.js'), 'utf8');
  const guardedSkills = [
    'skill_arxiv_search',
    'skill_arxiv_get',
    'skill_arxiv_latest',
    'skill_weather',
    'skill_qqbot_dep_check',
    'skill_skill_validate',
    'skill_clawddocs_search',
    'skill_clawddocs_fetch',
    'skill_summarize',
    'skill_stock_price_query',
    'skill_stock_dividend',
    'skill_stock_portfolio',
    'skill_stock_hot',
    'skill_stock_rumor',
    'skill_stock_analyze',
    'skill_stock_watchlist',
    'skill_ontology_graph',
    'skill_youtube_transcript',
    'skill_ppt_generate',
    'skill_ppt_theme_list',
    'skill_image_generate_pro'
  ];

  for (const name of guardedSkills) {
    const idx = source.indexOf(`${name}: async`);
    assert.ok(idx >= 0, `${name} executor missing`);
    const chunk = source.slice(idx, idx + 1200);
    assert.ok(!chunk.includes('runSkillPython('), `${name} still depends on runSkillPython`);
    assert.ok(!chunk.includes('runShellSkillScript('), `${name} still depends on runShellSkillScript`);
    assert.ok(!chunk.includes('runSkillNode('), `${name} still depends on runSkillNode`);
  }

  console.log('noExternalProcessSkillsSource.test.js passed');
})();

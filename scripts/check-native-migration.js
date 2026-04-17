const fs = require('fs');
const path = require('path');

const targetSkills = [
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

function main() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'toolExecutors.js'), 'utf8');
  const results = targetSkills.map((name) => {
    const idx = source.indexOf(`${name}: async`);
    const chunk = idx >= 0 ? source.slice(idx, idx + 1500) : '';
    return {
      name,
      present: idx >= 0,
      usesRunSkillPython: chunk.includes('runSkillPython('),
      usesRunShellSkillScript: chunk.includes('runShellSkillScript('),
      usesRunSkillNode: chunk.includes('runSkillNode(')
    };
  });
  console.log(JSON.stringify({
    total: results.length,
    migrated: results.filter((item) => item.present && !item.usesRunSkillPython && !item.usesRunShellSkillScript && !item.usesRunSkillNode).length,
    results
  }, null, 2));
}

main();

const path = require('path');
const { TOOL_EXECUTORS } = require('../api/toolExecutors');

function preview(value, limit = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

function classifyResult(output = '') {
  const text = String(output || '').trim();
  if (!text) return 'empty';
  if (
    /^Missing [A-Z0-9_]+/i.test(text)
    || /^AI PPT .* unavailable\./i.test(text)
    || /未配置可用的 YouTube transcript HTTP provider/i.test(text)
    || /^AI PPT HTTP provider is not configured yet\./i.test(text)
  ) {
    return 'config_required';
  }
  if (
    /429/.test(text)
    || /限流/.test(text)
    || /超时/.test(text)
    || /请求失败/.test(text)
    || /暂时不可用/.test(text)
    || /failed/i.test(text)
    || /error:/i.test(text)
    || /查询失败/i.test(text)
    || /未找到/i.test(text)
    || /not found/i.test(text)
    || /schema: missing/i.test(text)
  ) {
    return 'degraded';
  }
  return 'ok';
}

function buildSkillArgs() {
  return {
    skill_agent_browser_guide: { query: 'browser automation basics' },
    skill_api_gateway_reference: { query: 'routing', reference: 'SKILL.md' },
    skill_arxiv_get: { arxiv_id: '2401.00001', include_abstract: false },
    skill_arxiv_latest: { categories: ['cs.AI'], max_results: 2 },
    skill_arxiv_search: { query: 'agent memory', max_results: 2 },
    skill_auto_updater_guide: { query: 'windows service update' },
    skill_brave_extract: { url: 'https://example.com' },
    skill_brave_search: { query: 'mizuki bot', max_results: 2 },
    skill_byterover_guide: { query: 'workspace setup' },
    skill_clawddocs_fetch: { doc_path: 'snippets/common-configs.md' },
    skill_clawddocs_reference: { query: 'config', reference: 'SKILL.md' },
    skill_clawddocs_search: { query: 'config' },
    skill_find_skills_guide: { query: 'discover skills' },
    skill_free_ride_guide: { query: 'network fallback' },
    skill_github_api_guide: { query: 'pull request auth' },
    skill_gog_guide: { query: 'game metadata' },
    skill_humanizer_guide: { query: 'rewrite tone' },
    skill_image_generate_pro: { prompt: 'a simple blue square logo' },
    skill_larry_guide: { query: 'task routing', reference: 'SKILL.md' },
    skill_n8n_workflow_guide: { query: 'webhook workflow' },
    skill_nano_pdf_guide: { query: 'pdf extract' },
    skill_obsidian_guide: { query: 'vault sync' },
    skill_ontology_graph: { action: 'validate' },
    skill_openai_whisper_guide: { query: 'transcription basics' },
    skill_ppt_generate: { query: 'AI project weekly review' },
    skill_ppt_theme_list: {},
    skill_proactive_agent_guide: { query: 'initiative policy', reference: 'SKILL.md' },
    skill_qqbot_dep_check: {},
    skill_research_cog_guide: { query: 'literature workflow' },
    skill_self_improving_agent_guide: { query: 'reflection loop', reference: 'SKILL.md' },
    skill_skill_validate: { skill_name: 'web-search' },
    skill_skillhub_preference_guide: { query: 'preference ranking' },
    skill_stock_analyze: { ticker: 'AAPL', fast: true },
    skill_stock_dividend: { ticker: 'AAPL' },
    skill_stock_hot: { no_social: true },
    skill_stock_portfolio: { action: 'list' },
    skill_stock_price_query: { ticker: 'AAPL' },
    skill_stock_rumor: {},
    skill_stock_watchlist: { action: 'list' },
    skill_summarize: { input: 'https://example.com', length: 'short' },
    skill_tavily_extract: { url: 'https://example.com' },
    skill_tavily_search: { query: 'mizuki bot', max_results: 2 },
    skill_vetter_report: { skill_name: 'web-search' },
    skill_weather: { location: 'Shanghai' },
    skill_web_search: { query: 'mizuki bot' },
    skill_youtube_api_guide: { query: 'youtube api setup' },
    skill_youtube_transcript: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }
  };
}

async function main() {
  const argsByName = buildSkillArgs();
  const names = Object.keys(TOOL_EXECUTORS).filter((name) => name.startsWith('skill_')).sort();
  const results = [];

  for (const name of names) {
    const args = argsByName[name] || {};
    const startedAt = Date.now();
    try {
      const output = await TOOL_EXECUTORS[name](args);
      results.push({
        name,
        ok: true,
        status: classifyResult(output),
        duration_ms: Date.now() - startedAt,
        args,
        preview: preview(output)
      });
    } catch (error) {
      results.push({
        name,
        ok: false,
        status: 'threw',
        duration_ms: Date.now() - startedAt,
        args,
        error: String(error?.message || error)
      });
    }
  }

  const summary = {
    cwd: process.cwd(),
    generated_at: new Date().toISOString(),
    count: results.length,
    ok: results.filter((item) => item.ok).length,
    threw: results.filter((item) => !item.ok).length,
    status_counts: results.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {})
  };

  console.log(JSON.stringify({ summary, results }, null, 2));
}

main().catch((error) => {
  console.error('[check-skills-full] fatal:', error?.stack || error?.message || error);
  process.exit(1);
});

/**
 * api/skills.js
 * ------------------------------------------------------------
 * 新增 Skills（可被 gpt 工具调用）
 * 不影响你原 tools.js，属于“高阶能力层”
 * ------------------------------------------------------------
 */

const axios = require('axios');
const cheerio = require('cheerio');
const dayjs = require('dayjs');
const config = require('../config');

// 统一 http client（和你现有风格一致）
function createHttpClient() {
  const opts = {
    timeout: config.TOOL_TIMEOUT_MS || 10000,
    proxy: false,
    headers: {
      'User-Agent': 'Mozilla/5.0 MizukiBot/Skills'
    }
  };
  return axios.create(opts);
}
const http = createHttpClient();

async function web_fetch_and_extract(url) {
  try {
    if (!/^https?:\/\//i.test(String(url || ''))) {
      return '链接格式不正确，需要以 http:// 或 https:// 开头。';
    }
    const resp = await http.get(url);
    const html = String(resp.data || '');
    const $ = cheerio.load(html);

    // 去噪
    $('script, style, noscript, iframe').remove();

    const title = $('title').first().text().trim() || '无标题';
    const h1 = $('h1').first().text().trim();
    const text = $('body').text().replace(/\s+/g, ' ').trim();

    // 截断，避免太长
    const snippet = text.slice(0, 2000);

    return JSON.stringify({
      ok: true,
      title,
      h1,
      content_snippet: snippet
    });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: e.message
    });
  }
}

async function task_plan(goal, constraints = '', days = 7) {
  const d = Number(days);
  const safeDays = Number.isFinite(d) && d > 0 ? Math.min(d, 60) : 7;

  // 这个 skill 返回结构化模板，让主模型二次润色
  const plan = {
    goal: String(goal || '').trim(),
    constraints: String(constraints || '').trim(),
    timeline_days: safeDays,
    phases: [
      { phase: '信息收集', day_range: '1-2', deliverable: '明确目标/资源/风险' },
      { phase: '执行启动', day_range: '3-4', deliverable: '完成最小可行版本' },
      { phase: '优化迭代', day_range: '5-6', deliverable: '修正问题并提升质量' },
      { phase: '验收复盘', day_range: '7', deliverable: '总结结果与下一步计划' }
    ]
  };
  return JSON.stringify(plan);
}

async function compare_options(options = [], criteria = []) {
  const arr = Array.isArray(options) ? options.filter(Boolean) : [];
  const cri = Array.isArray(criteria) ? criteria.filter(Boolean) : ['成本', '时间', '效果', '风险'];

  if (arr.length < 2) {
    return '至少需要2个方案才能对比。';
  }

  // 简单打分骨架，最终让模型结合上下文解释
  const table = arr.map((name, idx) => ({
    option: name,
    scores: Object.fromEntries(cri.map(c => [c, 6 + ((idx + c.length) % 4)])), // 6~9演示分
    total: 0
  }));

  table.forEach(row => {
    row.total = Object.values(row.scores).reduce((a, b) => a + b, 0);
  });

  table.sort((a, b) => b.total - a.total);

  return JSON.stringify({
    criteria: cri,
    ranking: table
  });
}

async function calendar_text_parser(text, timezone = 'Asia/Shanghai') {
  const t = String(text || '').trim();
  if (!t) return '请输入要解析的提醒文本。';

  // 轻量规则解析（可继续扩展）
  let due = dayjs();
  if (/明天/.test(t)) due = due.add(1, 'day');
  if (/后天/.test(t)) due = due.add(2, 'day');

  // 时间点解析（如 18:30）
  const m = t.match(/(\d{1,2})[:：](\d{1,2})/);
  if (m) {
    const hh = Math.min(23, Number(m[1]));
    const mm = Math.min(59, Number(m[2]));
    due = due.hour(hh).minute(mm).second(0);
  } else {
    due = due.hour(20).minute(0).second(0); // 默认晚8点
  }

  return JSON.stringify({
    title: t.replace(/明天|后天|\d{1,2}[:：]\d{1,2}/g, '').trim() || '待办事项',
    due_at: due.format('YYYY-MM-DD HH:mm:ss'),
    timezone,
    source_text: t
  });
}

async function code_explain(code, lang = 'javascript') {
  const c = String(code || '').trim();
  if (!c) return '请提供代码内容。';

  // 先做静态摘要，详细解释交给主模型
  const lines = c.split('\n').length;
  const chars = c.length;
  return JSON.stringify({
    lang,
    lines,
    chars,
    hints: [
      '可解释代码整体作用',
      '可逐段说明关键逻辑',
      '可给出重构建议和复杂度分析',
      '可指出潜在异常处理缺口'
    ]
  });
}

async function fact_check_bundle(claim, keywords = '') {
  const c = String(claim || '').trim();
  if (!c) return '请提供待核验的陈述。';

  // 返回核验流程模板，主模型可据此发起 web_search/tool 组合
  return JSON.stringify({
    claim: c,
    keywords: String(keywords || '').trim(),
    checklist: [
      '拆分可验证子命题',
      '检索至少2个独立来源',
      '标记时间敏感信息',
      '区分事实/观点',
      '输出置信度与不确定点'
    ]
  });
}

module.exports = {
  web_fetch_and_extract,
  task_plan,
  compare_options,
  calendar_text_parser,
  code_explain,
  fact_check_bundle
};

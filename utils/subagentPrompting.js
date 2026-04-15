const OPENCLAW_TOOL_HINT_MAP = {
  skill_weather: 'web_search',
  getWeather: 'web_search',
  skill_web_search: 'web_search',
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  skill_summarize: 'web_fetch',
  skill_brave_extract: 'web_fetch',
  skill_tavily_extract: 'web_fetch',
  read_rss_feed: 'web_fetch'
};

const OPENCLAW_ROUTE_EXECUTION_GUIDANCE = {
  weather: '执行要求: 严格按计划推进。先搜索可靠天气来源，再读取具体天气信息；如果拿不到明确温度或降雨数据，再改用 browser 查看页面或更换来源。',
  search: '执行要求: 严格按计划推进。搜索后不要停在摘要层，必须继续读取正文；如果用户明确要求官方文档、最新信息或可信来源，优先选这些来源，并在答案里说明依据；如果抓取正文为空或明显残缺，再改用 browser 查看页面。',
  summarize: '执行要求: 先定位目标，再读取正文后总结；正文抓取不完整时改用 browser。',
  research: '执行要求: 先搜索候选来源，再读取核心正文后输出结论；如果抓取内容不足，再改用 browser 查看关键页面。',
  notebook: '执行要求: 先明确检索范围，再查询笔记内容，最后只基于命中的笔记证据回答。',
  stock: '执行要求: 先确认资产范围，再收集行情或组合上下文，最后输出分析并明确风险和不确定性。',
  productivity: '执行要求: 先明确目标和约束，再生成可执行的计划或产出，不要只停留在泛泛建议。',
  act: '执行要求: 先确认用户要执行的具体动作、目标对象和约束；只有在动作边界清晰且当前能力可执行时才继续，否则先明确说明限制或缺失信息，不要擅自替用户做高风险决定。',
  quiz: '执行要求: 先确认主题和难度，再生成题目并做一次难度校准，最后给出可直接使用的题目。'
};

function normalizeToolHintsForBackend(toolHints = [], backend = 'command') {
  const hints = Array.isArray(toolHints)
    ? toolHints.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)
    : [];
  const mode = String(backend || 'command').trim().toLowerCase();
  if (!hints.length) return [];
  if (mode !== 'openclaw') return hints;

  const mapped = hints.map((hint) => OPENCLAW_TOOL_HINT_MAP[hint] || '');
  return Array.from(new Set(mapped.filter(Boolean)));
}

function buildSubagentToolReasonLine(route = {}, backend = 'command') {
  const normalizedHints = normalizeToolHintsForBackend(route?.toolHints, backend);
  if (!normalizedHints.length) return '';

  if (String(backend || '').trim().toLowerCase() === 'openclaw') {
    return `优先考虑这些可用能力: ${normalizedHints.join(', ')}`;
  }

  return `优先考虑这些工具/技能: ${normalizedHints.join(', ')}`;
}

function formatPlanStep(step = {}, index = 0) {
  const name = String(step?.step || `step_${index + 1}`).trim();
  const instruction = String(step?.instruction || '').trim();
  const preferredTools = Array.isArray(step?.preferredTools)
    ? step.preferredTools.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)
    : [];
  const required = Array.isArray(step?.required)
    ? step.required.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)
    : [];
  const produces = String(step?.produces || '').trim();
  const successCheck = String(step?.successCheck || '').trim();
  const toolPart = preferredTools.length ? `; 优先工具: ${preferredTools.join(', ')}` : '';
  const requiredPart = required.length ? `; 前置输入: ${required.join(', ')}` : '';
  const outputPart = produces ? `; 产出: ${produces}` : '';
  const successPart = successCheck ? `; 完成判定: ${successCheck}` : '';
  const optionalPart = step?.optional ? '; 可选兜底步骤' : '';
  return `${index + 1}. ${name}: ${instruction}${toolPart}${requiredPart}${outputPart}${successPart}${optionalPart}`;
}

function buildSubagentExecutionPlanLines(routeExecutionPlan = {}, backend = 'command') {
  const mode = String(backend || 'command').trim().toLowerCase();
  if (mode !== 'openclaw') return [];

  const steps = Array.isArray(routeExecutionPlan?.planSteps) ? routeExecutionPlan.planSteps : [];
  if (!steps.length) return [];

  return steps.map((step, index) => formatPlanStep(step, index));
}

function buildSubagentExecutionGuidanceLine(route = {}, backend = 'command', routeExecutionPlan = {}) {
  const mode = String(backend || 'command').trim().toLowerCase();
  if (mode !== 'openclaw') return '';

  const routeDebugKey = String(routeExecutionPlan?.routeDebugKey || route?.routeDebugKey || '').trim().toLowerCase();
  const topRouteType = String(routeExecutionPlan?.topRouteType || route?.topRouteType || 'direct_chat').trim().toLowerCase();
  const guidanceKey = (
    routeDebugKey === 'admin/full' ? 'research'
      : routeDebugKey.includes('/summary') ? 'summarize'
        : routeDebugKey.includes('/plan') ? 'productivity'
          : routeDebugKey.includes('/action_guidance') ? 'act'
            : topRouteType === 'admin' ? 'research'
              : ''
  );
  return OPENCLAW_ROUTE_EXECUTION_GUIDANCE[guidanceKey] || '';
}

module.exports = {
  OPENCLAW_ROUTE_EXECUTION_GUIDANCE,
  OPENCLAW_TOOL_HINT_MAP,
  buildSubagentExecutionGuidanceLine,
  buildSubagentExecutionPlanLines,
  buildSubagentToolReasonLine,
  normalizeToolHintsForBackend
};

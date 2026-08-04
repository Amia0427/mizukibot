const MAIMAI_SIGNAL = /(舞萌|maimai|mai\s*mai|紫谱|白谱|DX\s*谱|标准谱|手法|纵连|交互|滑键|掉音|定数)/i;
const PLAYER_SIGNAL = /(我的成绩|成绩分析|成绩弱项|弱项|擅长|不擅长|个人表现|rating|分数)/i;
const ANALYZE_SIGNAL = /(分析|谱面特征|手法|纵连|交互|滑键|掉音|哪里难|难点)/i;
const MAIMAI_TOOLS = Object.freeze([
  'maimai_chart_search',
  'maimai_chart_analyze',
  'maimai_player_analysis'
]);

function isMaimaiQuestion(text = '') {
  return MAIMAI_SIGNAL.test(String(text || '').trim());
}

function chooseMaimaiTool(text = '', allowedToolNames = []) {
  const allowed = new Set((Array.isArray(allowedToolNames) ? allowedToolNames : []).map((name) => String(name || '').trim()));
  const cleanText = String(text || '').trim();
  if (!isMaimaiQuestion(cleanText)) return [];
  if (PLAYER_SIGNAL.test(cleanText) && allowed.has('maimai_player_analysis')) return ['maimai_player_analysis'];
  if (ANALYZE_SIGNAL.test(cleanText) && allowed.has('maimai_chart_analyze')) return ['maimai_chart_analyze'];
  if (allowed.has('maimai_chart_search')) return ['maimai_chart_search'];
  if (allowed.has('maimai_chart_analyze')) return ['maimai_chart_analyze'];
  return [];
}

function applyMaimaiToolRouting(route = {}) {
  if (!route || typeof route !== 'object' || route.topRouteType !== 'direct_chat') return route;
  const meta = route.meta && typeof route.meta === 'object' ? route.meta : {};
  const text = String(meta.effectiveIntentText || route.question || route.cleanText || route.rawText || '');
  const selected = chooseMaimaiTool(text, MAIMAI_TOOLS);
  if (selected.length === 0) return route;
  const existing = (Array.isArray(meta.allowedTools) ? meta.allowedTools : [])
    .map((name) => String(name || '').trim())
    .filter((name) => name && !MAIMAI_TOOLS.includes(name));
  return {
    ...route,
    meta: {
      ...meta,
      allowedTools: Array.from(new Set([...existing, ...selected])),
      toolIntent: 'force_tools'
    }
  };
}

module.exports = { MAIMAI_TOOLS, applyMaimaiToolRouting, chooseMaimaiTool, isMaimaiQuestion };

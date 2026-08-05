const { isPjskEnabled } = require('./feature-flags');
const { pjskReferenceStore } = require('./reference-store');

const PJSK_TOOLS = Object.freeze(['pjsk_song_search', 'pjsk_chart_analyze']);
const DOMAIN_SIGNAL = /(?:\bPJSK\b|Project\s+Sekai|プロセカ|世界计划|世界計画)/i;
const DATA_SIGNAL = /(?:曲库|曲庫|曲目|歌曲|曲名|谱|譜|难度|難度|等级|等級|物量|note|BPM|手法|Flick|Slide|Trace|Critical|Easy|Normal|Hard|Expert|Master|Append)/i;
const SEARCH_SIGNAL = /(?:查|搜|找|筛|篩|推荐|推薦|比较|比較|对比|對比|列出|哪些|有什么|多少|以上|以下|区间|區間|范围|範圍|曲库|曲庫)/i;
const ANALYZE_SIGNAL = /(?:分析|特征|特徵|难点|難點|密度|多押|宽键|寬鍵|滑条|滑條|变速|變速|代表段|峰值|谱面图|譜面圖|看谱|看譜|发图|發圖)/i;

function classifyPjskIntent(text = '', options = {}) {
  const currentText = String(text || '').normalize('NFKC').trim();
  if (!currentText) return { matched: false, intent: 'none', tool: '', reason: 'empty' };
  if (options.referenceToken) {
    return { matched: true, intent: 'analyze', tool: 'pjsk_chart_analyze', reason: 'trusted_reference' };
  }
  if (!DOMAIN_SIGNAL.test(currentText)) return { matched: false, intent: 'none', tool: '', reason: 'no_domain' };
  if (!DATA_SIGNAL.test(currentText)) return { matched: false, intent: 'none', tool: '', reason: 'no_data_intent' };
  if (SEARCH_SIGNAL.test(currentText)) return { matched: true, intent: 'search', tool: 'pjsk_song_search', reason: 'explicit_search' };
  if (ANALYZE_SIGNAL.test(currentText)) return { matched: true, intent: 'analyze', tool: 'pjsk_chart_analyze', reason: 'single_chart_analysis' };
  return { matched: true, intent: 'search', tool: 'pjsk_song_search', reason: 'catalog_lookup' };
}

function choosePjskTool(text = '', allowedToolNames = []) {
  const allowed = new Set(allowedToolNames);
  const decision = classifyPjskIntent(text);
  return decision.matched && allowed.has(decision.tool) ? [decision.tool] : [];
}

function applyPjskToolRouting(route = {}, options = {}) {
  if (!route || route.topRouteType !== 'direct_chat') return route;
  const meta = route.meta && typeof route.meta === 'object' ? route.meta : {};
  const currentText = String(route.cleanText || route.question || route.rawText || '').trim();
  const context = { userId: options.userId, chatType: options.chatType, routeMeta: meta };
  const prepared = meta.pjskReferenceToken
    ? { token: meta.pjskReferenceToken, expiresAt: meta.pjskReferenceExpiresAt }
    : pjskReferenceStore.prepareNextTurn(context, currentText);
  const existingTools = (Array.isArray(meta.allowedTools) ? meta.allowedTools : []).map(String).filter(Boolean);
  const otherTools = existingTools.filter((name) => !PJSK_TOOLS.includes(name));
  const hadPjskTool = otherTools.length !== existingTools.length;
  const enabled = options.enabled === undefined ? isPjskEnabled() : options.enabled === true;
  const decision = enabled
    ? classifyPjskIntent(currentText, { referenceToken: prepared?.token })
    : { matched: false, intent: 'none', tool: '', reason: 'feature_disabled' };
  if (!decision.matched) {
    if (!hadPjskTool) return route;
    return {
      ...route,
      meta: {
        ...meta,
        allowedTools: otherTools,
        toolIntent: meta.toolIntent === 'force_tools' && otherTools.length === 0 ? 'none' : meta.toolIntent
      }
    };
  }
  return {
    ...route,
    meta: {
      ...meta,
      allowedTools: Array.from(new Set([...otherTools, decision.tool])),
      toolIntent: 'force_tools',
      pjskIntent: decision.intent,
      pjskRouteReason: decision.reason,
      ...(prepared ? { pjskReferenceToken: prepared.token, pjskReferenceExpiresAt: prepared.expiresAt } : {})
    }
  };
}

module.exports = { PJSK_TOOLS, applyPjskToolRouting, choosePjskTool, classifyPjskIntent };

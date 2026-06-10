async function planQzoneDailyShareMemoryQuery(input = {}, options = {}) {
  const fallbackQuery = buildQzoneDailyShareMemoryFallbackQuery(input);
  const planner = typeof options.memoryQueryPlanner === 'function'
    ? options.memoryQueryPlanner
    : requestAssistantMessage;
  if (typeof planner !== 'function') {
    return { query: fallbackQuery, usedFallback: true, plannerError: 'planner-unavailable' };
  }

  const prompt = [
    '你只负责为 qzone daily share 规划一条 mem search 查询词。',
    '输出必须是严格 JSON。',
    'JSON 只能是 {"query":"..."}。',
    '不要输出 markdown，不要解释，不要输出命令。',
    'query 必须简短、泛化、适合检索，不要写成长句。',
    '不要放昵称、群聊原句、精确时间、链接、QQ号、手机号。',
    '',
    `[type]\n${String(input.type || '').trim().toLowerCase() || 'mood'}`,
    '',
    `[window]\n${String(input.windowKey || '').trim().toLowerCase() || 'unknown'} / ${String(input.windowLabel || '').trim() || 'unknown'}`,
    '',
    `[daypart_tone]\n${String(input.daypartTone || '').trim() || 'none'}`,
    '',
    `[topic_label]\n${String(input.topicLabel || '').trim() || 'none'}`,
    '',
    `[recent_qzone_summaries]\n${String(input.recentShareSummaries || '').trim() || 'none'}`
  ].join('\n');

  try {
    const response = await planner([
      { role: 'system', content: prompt },
      { role: 'user', content: '只输出严格 JSON。' }
    ], {
      disableTools: true,
      userId: String(config.BOT_QQ || '').trim(),
      routeMeta: {
        taskType: 'daily_share',
        surface: 'qzone',
        routePolicyKey: 'proactive/daily-share'
      }
    });
    const planned = parsePlannerQueryResponse(response);
    if (planned) return { query: planned, usedFallback: false, plannerError: '' };
  } catch (error) {
    return {
      query: fallbackQuery,
      usedFallback: true,
      plannerError: String(error?.message || error || 'planner-failed')
    };
  }

  return { query: fallbackQuery, usedFallback: true, plannerError: 'planner-invalid-json' };
}

const QZONE_MEMORY_OPEN_PRIORITY = Object.freeze([
  'recent',
  'journal',
  'personal',
  'style',
  'task',
  'profile',
  'jargon'
]);

function pickQzoneMemoryOpenCandidate(results = []) {
  const items = Array.isArray(results) ? results : [];
  for (const source of QZONE_MEMORY_OPEN_PRIORITY) {
    const found = items.find((item) => String(item?.source || '').trim().toLowerCase() === source && String(item?.ref || '').trim());
    if (found) return found;
  }
  return null;
}

function maskSensitiveText(value = '', maxChars = 220) {
  let text = String(value || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/@[\w\u4e00-\u9fa5_-]+/g, '')
    .replace(/(^|[^\d])1\d{10}([^\d]|$)/g, '$1鏌愪釜鍙风爜$2')
    .replace(/(^|[^\d])\d{5,12}([^\d]|$)/g, '$1鏌愪釜缂栧彿$2')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '鏌愪釜鏃堕棿')
    .replace(/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/g, '鏌愬ぉ')
    .replace(/\d{1,2}月\d{1,2}日/g, '某天')
    .replace(/[“”"'`「」『』]/g, '')
    .replace(/(?:群里|有人|谁[^\n]{0,16}(?:说|问|提到|聊到)[^\n]{0,24})/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const limit = Math.max(60, Number(maxChars) || 220);
  return text.length > limit ? `${text.slice(0, limit - 3).trim()}...` : text;
}


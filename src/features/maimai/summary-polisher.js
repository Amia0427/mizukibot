const { postWithRetry } = require('../../../api/httpClient');
const { extractJsonSafely, extractMessageContent } = require('../../../api/parser');
const { buildFactsText } = require('./summary');

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .join('');
}

function buildPolishPrompt(batch = []) {
  const facts = batch.map(({ chart = {} }) => ({
    chartKey: chart.chartKey,
    facts: buildFactsText(chart),
    tags: chart.techniqueTags || [],
    values: {
      density: chart.density,
      peakDensity: chart.peakDensity,
      chordCount: chart.chordCount,
      interactionCount: chart.interactionCount,
      verticalStreamCount: chart.verticalStreamCount,
      slideComboCount: chart.slideComboCount
    },
    segments: (chart.segments || []).slice(0, 3).map((segment) => ({
      segmentIndex: segment.segmentIndex,
      startTime: segment.startTime,
      endTime: segment.endTime,
      intensity: segment.intensity,
      rawText: segment.rawText
    }))
  }));

  return [
    '请润色舞萌谱面事实摘要，只返回 JSON。',
    '输出必须是与输入同顺序、同长度的数组。每项结构为：',
    '{"chartKey":"","segmentCount":0,"text":"","segments":[{"segmentIndex":0,"text":""}],"tags":[],"values":{}}',
    'chartKey、segmentCount、segmentIndex、tags 和 values 必须逐字沿用输入事实；不得新增事实、数值、手法标签或实际掉音位置。',
    JSON.stringify(facts)
  ].join('\n');
}

function createModelSummaryPolisher(options = {}) {
  const apiBaseUrl = String(options.apiBaseUrl || '').trim();
  const apiKey = String(options.apiKey || '').trim();
  const model = String(options.model || '').trim();
  if (!apiBaseUrl || !apiKey || !model) return null;

  const post = options.postWithRetry || postWithRetry;
  const retries = Math.max(0, Number(options.retries) || 0);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 120000);

  return async function polish(batch = []) {
    if (batch.length === 0) return [];
    const response = await post(
      apiBaseUrl,
      {
        model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: '你负责润色舞萌谱面事实摘要。严格保持事实，只输出 JSON。'
          },
          { role: 'user', content: buildPolishPrompt(batch) }
        ],
        max_tokens: 4000,
        stream: false,
        __preferredProtocol: 'chat_completions',
        __timeoutMs: timeoutMs,
        __trace: {
          source: 'maimai_sync_worker',
          phase: 'summary_polish',
          purpose: 'maimai_chart_summary_polish'
        }
      },
      retries,
      apiKey
    );
    const message = extractMessageContent(response);
    const parsed = extractJsonSafely(normalizeContent(message?.content));
    const items = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(items) || items.length !== batch.length) {
      throw new Error('maimai summary model returned an invalid batch');
    }
    return items;
  };
}

module.exports = {
  buildPolishPrompt,
  createModelSummaryPolisher
};

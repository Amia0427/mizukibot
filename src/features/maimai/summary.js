const crypto = require('crypto');

const SUMMARY_PROMPT_VERSION = 'maimai_summary_prompt_v1';
const SUMMARY_MODEL_VERSION = 'deterministic';

function hashText(value = '') {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function buildFactsText(chart = {}) {
  const counts = chart.noteCounts || {};
  return [
    `曲目：${chart.title || ''}`,
    `谱面：${chart.chartKey || ''} ${chart.chartType || ''} ${chart.difficultyIndex ?? ''} ${chart.level || ''}`,
    `定数：${number(chart.constant)}，总物量：${number(chart.noteTotal)}`,
    `Tap ${number(counts.tap)}、Touch ${number(counts.touch)}、Hold ${number(counts.hold)}、Slide ${number(counts.slide)}、Break ${number(counts.break)}`,
    `密度 ${number(chart.density)}，峰值 ${number(chart.peakDensity)}，双押 ${number(chart.chordCount)}，交互 ${number(chart.interactionCount)}，纵连 ${number(chart.verticalStreamCount)}，滑键组合 ${number(chart.slideComboCount)}`,
    `手法标签：${(chart.techniqueTags || []).join('、') || '无'}`
  ].join('；');
}

function deterministicSegmentText(segment = {}, chart = {}) {
  const tags = Array.isArray(chart.techniqueTags) ? chart.techniqueTags.slice(0, 3) : [];
  const tagText = tags.length > 0 ? tags.join('、') : '基础节奏';
  return `${chart.title || '该谱面'}在 ${number(segment.startTime).toFixed(1)}-${number(segment.endTime).toFixed(1)} 秒段强度约 ${number(segment.intensity).toFixed(2)}，主要体现${tagText}。`;
}

function buildChartDocuments(chart = {}, summary = null) {
  const factsText = buildFactsText(chart);
  const summaryText = String(summary?.text || '').trim();
  const globalText = `${factsText}${summaryText ? `；谱面概述：${summaryText}` : ''}。该摘要只描述解析得到的统计特征，不声称实际掉音位置。`;
  const documents = [{
    id: `${chart.chartKey}:global`,
    chartKey: chart.chartKey,
    contentHash: chart.contentHash || hashText(globalText),
    generationId: chart.generationId || 0,
    segmentIndex: -1,
    text: globalText,
    kind: 'global'
  }];
  for (const segment of (chart.segments || []).slice(0, 3)) {
    const segmentSummary = summary?.segments?.find(
      (item) => number(item.segmentIndex) === number(segment.segmentIndex)
    );
    const polishedText = String(segmentSummary?.text || '').trim();
    const text = `${factsText}；代表段 ${number(segment.startTime).toFixed(1)}-${number(segment.endTime).toFixed(1)} 秒，强度 ${number(segment.intensity).toFixed(2)}${polishedText ? `；段落摘要：${polishedText}` : ''}；原始 Simai：${segment.rawText || ''}`;
    documents.push({
      id: `${chart.chartKey}:segment:${segment.segmentIndex}`,
      chartKey: chart.chartKey,
      contentHash: chart.contentHash || hashText(text),
      generationId: chart.generationId || 0,
      segmentIndex: number(segment.segmentIndex),
      text,
      kind: 'segment'
    });
  }
  return documents;
}

function validatePolishedSummary(value, facts = {}) {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'not_object' };
  if (String(value.chartKey || '') !== String(facts.chartKey || '')) return { ok: false, reason: 'chart_key_mismatch' };
  const factSegments = Array.isArray(facts.segments) ? facts.segments.slice(0, 3) : [];
  const expectedSegments = factSegments.length;
  if (Number(value.segmentCount) !== expectedSegments) return { ok: false, reason: 'segment_count_mismatch' };
  if (!Array.isArray(value.segments) || value.segments.length !== expectedSegments) {
    return { ok: false, reason: 'segments_mismatch' };
  }
  for (let index = 0; index < factSegments.length; index += 1) {
    if (Number(value.segments[index]?.segmentIndex) !== Number(factSegments[index].segmentIndex)) {
      return { ok: false, reason: 'segment_id_mismatch' };
    }
  }
  const allowedTags = new Set(facts.techniqueTags || []);
  if (!Array.isArray(value.tags) || value.tags.some((tag) => !allowedTags.has(tag))) return { ok: false, reason: 'unknown_tag' };
  if (!value.values || typeof value.values !== 'object') return { ok: false, reason: 'missing_values' };
  for (const key of ['density', 'peakDensity', 'chordCount', 'interactionCount', 'verticalStreamCount', 'slideComboCount']) {
    if (value.values[key] !== undefined && number(value.values[key]) !== number(facts[key])) return { ok: false, reason: `value_mismatch:${key}` };
  }
  return { ok: true, value };
}

function createSummaryGenerator(options = {}) {
  const polish = typeof options.polish === 'function' ? options.polish : null;
  const cache = options.cache || new Map();
  const batchSize = 8;

  async function generate(charts = []) {
    const output = [];
    for (let offset = 0; offset < charts.length; offset += batchSize) {
      const batch = charts.slice(offset, offset + batchSize);
      const pending = [];
      for (const chart of batch) {
        const cacheKey = `${chart.contentHash || hashText(buildFactsText(chart))}:${SUMMARY_PROMPT_VERSION}:${options.modelVersion || SUMMARY_MODEL_VERSION}`;
        const cached = cache.get(cacheKey);
        if (cached) output.push(cached);
        else pending.push({ chart, cacheKey });
      }
      if (pending.length === 0) continue;
      let polished = [];
      if (polish) {
        try {
          const candidates = await polish(pending.map((item) => ({ chart: item.chart, documents: buildChartDocuments(item.chart) })));
          polished = Array.isArray(candidates) ? candidates : [];
        } catch (_) {
          polished = [];
        }
      }
      for (let index = 0; index < pending.length; index += 1) {
        const { chart, cacheKey } = pending[index];
        const candidate = polished[index];
        const validation = validatePolishedSummary(candidate, chart);
        const segments = (chart.segments || []).slice(0, 3).map((segment) => {
          const templateText = deterministicSegmentText(segment, chart);
          const polishedSegment = validation.ok
            ? candidate.segments.find((item) => number(item.segmentIndex) === number(segment.segmentIndex))
            : null;
          return {
            segmentIndex: number(segment.segmentIndex),
            templateText,
            text: polishedSegment?.text
              ? String(polishedSegment.text)
              : templateText
          };
        });
        const result = {
          chartKey: chart.chartKey,
          contentHash: chart.contentHash || '',
          text: validation.ok && candidate.text ? String(candidate.text) : buildFactsText(chart),
          segments,
          mode: validation.ok ? 'polished' : 'deterministic_fallback',
          promptVersion: SUMMARY_PROMPT_VERSION,
          modelVersion: options.modelVersion || SUMMARY_MODEL_VERSION
        };
        cache.set(cacheKey, result);
        output.push(result);
      }
    }
    return output;
  }

  return { generate };
}

module.exports = {
  SUMMARY_MODEL_VERSION,
  SUMMARY_PROMPT_VERSION,
  buildChartDocuments,
  buildFactsText,
  createSummaryGenerator,
  hashText,
  validatePolishedSummary
};

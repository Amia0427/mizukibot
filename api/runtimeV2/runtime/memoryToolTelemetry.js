function safeParseJson(text = '') {
  try {
    return JSON.parse(String(text || ''));
  } catch (_) {
    return null;
  }
}

function buildMemoryToolTelemetry(envelope = {}) {
  if (String(envelope?.tool_name || envelope?.tool || '').trim() !== 'memory_cli') return {};
  const parsed = safeParseJson(envelope.result);
  if (!parsed || typeof parsed !== 'object') return {};
  return {
    memoryCliResultCount: Number(parsed.count || (Array.isArray(parsed.results) ? parsed.results.length : 0)) || 0,
    topResultQuality: String(parsed.qualitySummary?.topResultQuality || parsed.results?.[0]?.evidenceQuality || '').trim(),
    rejectedResultCount: Number(parsed.rejectedResultCount || parsed.qualitySummary?.rejectedResultCount || 0) || 0,
    memoryEvidenceQuality: parsed.qualitySummary || null
  };
}

module.exports = {
  buildMemoryToolTelemetry
};

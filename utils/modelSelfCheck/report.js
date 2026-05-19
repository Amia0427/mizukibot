const { normalizeText } = require('./common');

function formatModelSelfCheckReport(results = []) {
  const rows = Array.isArray(results) ? results : [];
  const lines = ['模型自检:'];
  for (const row of rows) {
    const type = normalizeText(row?.type) || 'unknown';
    const model = normalizeText(row?.model) || '-';
    const status = normalizeText(row?.status) || 'failed';
    const timeout = row?.timedOut === true ? 'true' : 'false';
    const duration = Number.isFinite(Number(row?.durationMs))
      ? `${Math.max(0, Math.floor(Number(row.durationMs)))}ms`
      : 'skipped';
    lines.push(`${type} | ${model} | ${duration} | ${status} | timeout=${timeout}`);
  }
  return lines.join('\n');
}

module.exports = {
  formatModelSelfCheckReport
};

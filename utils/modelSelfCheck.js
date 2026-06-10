const {
  CHECK_TYPES,
  clampTimeoutMs,
  createSkippedResult,
  isTimeoutError
} = require('./modelSelfCheck/common');
const { formatModelSelfCheckReport } = require('./modelSelfCheck/report');
const { runCheckRequest } = require('./modelSelfCheck/runner');
const { buildSelfCheckSpecs } = require('./modelSelfCheck/specs');

async function runModelSelfCheck(options = {}) {
  const specs = buildSelfCheckSpecs(options);
  const results = await Promise.all(specs.map((spec) => runCheckRequest(spec, options)));
  const byType = new Map(results.map((result) => [result.type, result]));
  return CHECK_TYPES.map((type) => byType.get(type) || createSkippedResult(type));
}

module.exports = {
  CHECK_TYPES,
  buildSelfCheckSpecs,
  clampTimeoutMs,
  formatModelSelfCheckReport,
  isTimeoutError,
  runCheckRequest,
  runModelSelfCheck
};

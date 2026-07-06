const assert = require('assert');

const {
  buildDiagnostic
} = require('../scripts/diagnose-short-term-context');

module.exports = (() => {
  let logged = false;
  const originalLog = console.log;
  let report;
  try {
    console.log = (message, ...rest) => {
      if (String(message || '').includes('[short-term-memory] session scope decision')) logged = true;
      return originalLog.call(console, message, ...rest);
    };
    report = buildDiagnostic({
      userId: 'u_diag_short_term',
      sessionKey: 'direct:u_diag_short_term',
      question: '继续',
      includeSiblingSessions: true,
      json: true
    });
  } finally {
    console.log = originalLog;
  }

  assert.strictEqual(report.schemaVersion, 'short_term_context_diagnostic_v1');
  assert.strictEqual(report.userId, 'u_diag_short_term');
  assert.strictEqual(report.sessionKey, 'direct:u_diag_short_term');
  assert.ok(report.estimatedTokens);
  assert.ok(report.contentShape);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(report, 'recentHistory'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(report, 'shortTermSummary'), false);
  assert.strictEqual(logged, false);

  console.log('shortTermContextDiagnostic.test.js passed');
})();

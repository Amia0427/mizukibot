const assert = require('assert');

const { main } = require('../scripts/diagnose-security');

function createReport(status) {
  return {
    status,
    summary: { ok: 0, warn: 0, error: 0 },
    findings: []
  };
}

for (const [status, expectedExitCode] of [
  ['ok', 0],
  ['warn', 0],
  ['error', 1]
]) {
  let output = '';
  const exitCode = main({
    argv: ['node', 'diagnose-security.js', '--json'],
    stdout: { write(chunk) { output += chunk; } },
    collectDiagnostics: () => createReport(status)
  });
  assert.strictEqual(exitCode, expectedExitCode);
  assert.strictEqual(JSON.parse(output).status, status);
}

console.log('diagnoseSecurityCli.test.js passed');

const assert = require('assert');

const { main } = require('../scripts/diagnose-security');

function run(report) {
  let output = '';
  const exitCode = main({
    argv: ['node', 'diagnose-security.js', '--json'],
    stdout: { write: (text) => { output += text; } },
    collectDiagnostics: () => report
  });
  return { exitCode, output: JSON.parse(output) };
}

const failed = run({ status: 'error', summary: { ok: 0, warn: 0, error: 1 }, findings: [] });
assert.strictEqual(failed.exitCode, 1);
assert.strictEqual(failed.output.status, 'error');

const warned = run({ status: 'warn', summary: { ok: 0, warn: 1, error: 0 }, findings: [] });
assert.strictEqual(warned.exitCode, 0);

console.log('securityDiagnosticsCli.test.js passed');

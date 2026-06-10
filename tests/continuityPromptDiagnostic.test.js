const assert = require('assert');
const { spawnSync } = require('child_process');

const result = spawnSync(
  process.execPath,
  [
    'scripts/diagnose-continuity-state.js',
    'prompt',
    '--user',
    'diagnose_cli_user',
    '--question',
    '继续刚才',
    '--json'
  ],
  {
    cwd: process.cwd(),
    encoding: 'utf8'
  }
);

assert.strictEqual(result.status, 0, result.stderr || result.stdout);
const parsed = JSON.parse(result.stdout);
assert.strictEqual(parsed.schemaVersion, 'continuity_prompt_diagnostic_v1');
assert.strictEqual(parsed.userId, 'diagnose_cli_user');
assert.ok(parsed.contextProfile);
assert.ok(parsed.observability);
assert.ok(Object.prototype.hasOwnProperty.call(parsed.trimReport, 'selectedRawTurnCount'));

console.log('continuityPromptDiagnostic.test.js passed');

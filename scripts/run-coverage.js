'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { applyDefaultTestEnv } = require('./run-tests');
const { checkCoverageFiles } = require('./check-coverage');

const rootDir = path.resolve(__dirname, '..');
const env = applyDefaultTestEnv({ ...process.env });
const runId = `${process.pid}-${Date.now()}`;
const tempDirectory = path.join(env.TEST_TEMP_ROOT, `coverage-v8-${runId}`);
const reportsDir = path.join(rootDir, 'artifacts', 'coverage');
const summaryPath = path.join(reportsDir, 'coverage-summary.json');
const baselinePath = path.join(rootDir, 'config', 'coverage-baseline.json');
const outputPath = path.join(reportsDir, 'baseline-check.json');
const baseline = require(baselinePath);
const c8Entry = require.resolve('c8/bin/c8.js');

const args = [
  c8Entry,
  '--all',
  '--clean=false',
  `--temp-directory=${tempDirectory}`,
  `--reports-dir=${reportsDir}`,
  '--reporter=text-summary',
  '--reporter=json-summary',
  '--reporter=lcov'
];
for (const include of baseline.include || []) args.push(`--include=${include}`);
args.push(process.execPath, path.join(rootDir, 'scripts', 'run-tests.js'));

const coverageRun = spawnSync(process.execPath, args, {
  cwd: rootDir,
  env,
  stdio: 'inherit'
});
if (coverageRun.error) throw coverageRun.error;
if (coverageRun.status !== 0) process.exit(coverageRun.status || 1);

const result = checkCoverageFiles({
  summaryPath,
  baselinePath,
  outputPath,
  rootDir
});
for (const scope of result.scopes) {
  console.log(`[coverage] ${scope.name} lines=${scope.lines.pct.toFixed(2)} functions=${scope.functions.pct.toFixed(2)} branches=${scope.branches.pct.toFixed(2)}`);
}
if (result.failures.length > 0) {
  for (const failure of result.failures) console.error(`[coverage] ${failure}`);
  process.exit(1);
}
console.log('[coverage] baseline passed');

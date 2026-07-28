'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { checkCoverageSummary } = require('../scripts/check-coverage');

const root = path.resolve(__dirname, '..');
const packageJson = require('../package.json');
const baseline = require('../config/coverage-baseline.json');

function metric(total, covered) {
  return { total, covered, skipped: 0, pct: total > 0 ? (covered / total) * 100 : 100 };
}

function fileCoverage(total, covered) {
  return {
    lines: metric(total, covered),
    statements: metric(total, covered),
    functions: metric(total, covered),
    branches: metric(total, covered)
  };
}

assert.strictEqual(packageJson.scripts.coverage, 'node scripts/run-coverage.js');
assert.strictEqual(packageJson.scripts['coverage:check'], 'node scripts/check-coverage.js');
assert.strictEqual(packageJson.devDependencies.c8, '11.0.0');
assert.strictEqual(baseline.version, 1);
assert.deepStrictEqual(baseline.include, [
  'index.js',
  'api/**/*.js',
  'config/**/*.js',
  'core/**/*.js',
  'src/**/*.js',
  'utils/**/*.js',
  'web/**/*.js'
]);
assert.ok(baseline.scopes.some((scope) => scope.name === 'overall-production'));
assert.ok(baseline.scopes.some((scope) => scope.name === 'runtime-v2-non-chunk'));
assert.ok(baseline.scopes.some((scope) => scope.name === 'stable-boundaries'));
assert.deepStrictEqual(
  Object.fromEntries(baseline.scopes.map((scope) => [scope.name, scope.minimum])),
  {
    'overall-production': { lines: 69, statements: 69, functions: 79, branches: 61 },
    web: { lines: 78, statements: 78, functions: 83, branches: 79 },
    'runtime-v2-non-chunk': { lines: 74, statements: 74, functions: 69, branches: 58 },
    'stable-boundaries': { lines: 84, statements: 84, functions: 80, branches: 70 }
  }
);

const fixtureRoot = path.join(root, 'coverage-fixture-root');
const fixtureSummary = {
  total: fileCoverage(20, 18),
  [path.join(fixtureRoot, 'web', 'auth.js')]: fileCoverage(10, 9),
  [path.join(fixtureRoot, 'utils', 'networkSafety.js')]: fileCoverage(10, 9)
};
const fixtureBaseline = {
  version: 1,
  include: ['web/**/*.js', 'utils/**/*.js'],
  scopes: [
    {
      name: 'fixture',
      selector: { files: ['web/auth.js', 'utils/networkSafety.js'] },
      minimum: { lines: 90, statements: 90, functions: 90, branches: 90 }
    }
  ]
};
const passing = checkCoverageSummary(fixtureSummary, fixtureBaseline, { rootDir: fixtureRoot });
assert.strictEqual(passing.status, 'passed');
assert.strictEqual(passing.scopes[0].files, 2);

for (const [name, mutate, expected] of [
  ['missing', (coverage) => { delete coverage.lines; }, 'lines.total must be a non-negative integer'],
  ['nan', (coverage) => { coverage.functions.total = Number.NaN; }, 'functions.total must be a non-negative integer'],
  ['negative', (coverage) => { coverage.branches.covered = -1; }, 'branches.covered must be an integer from 0 to total'],
  ['overflow', (coverage) => { coverage.statements.covered = 11; }, 'statements.covered must be an integer from 0 to total']
]) {
  const malformedSummary = {
    total: fileCoverage(20, 18),
    [path.join(fixtureRoot, 'web', 'auth.js')]: fileCoverage(10, 9),
    [path.join(fixtureRoot, 'utils', 'networkSafety.js')]: fileCoverage(10, 9)
  };
  mutate(malformedSummary[path.join(fixtureRoot, 'web', 'auth.js')]);
  const malformed = checkCoverageSummary(malformedSummary, fixtureBaseline, { rootDir: fixtureRoot });
  assert.strictEqual(malformed.status, 'failed', name);
  assert.ok(malformed.failures.some((failure) => failure.includes(expected)), name);
}

fixtureBaseline.scopes[0].minimum.branches = 91;
const regression = checkCoverageSummary(fixtureSummary, fixtureBaseline, { rootDir: fixtureRoot });
assert.strictEqual(regression.status, 'failed');
assert.match(regression.failures[0], /branches 90\.00 < 91\.00/);

fixtureBaseline.scopes[0].selector.files.push('web/missing.js');
const missing = checkCoverageSummary(fixtureSummary, fixtureBaseline, { rootDir: fixtureRoot });
assert.ok(missing.failures.some((failure) => failure.includes('missing web/missing.js')));

delete fixtureBaseline.scopes[0].minimum.lines;
const invalidMinimum = checkCoverageSummary(fixtureSummary, fixtureBaseline, { rootDir: fixtureRoot });
assert.ok(invalidMinimum.failures.some((failure) => failure.includes('invalid baseline: fixture: lines minimum')));

fixtureBaseline.scopes[0].minimum.lines = -1;
fixtureBaseline.scopes.push({ ...fixtureBaseline.scopes[0] });
const duplicateScope = checkCoverageSummary(fixtureSummary, fixtureBaseline, { rootDir: fixtureRoot });
assert.ok(duplicateScope.failures.some((failure) => failure.includes('duplicate scope name: fixture')));
assert.ok(duplicateScope.failures.some((failure) => failure.includes('lines minimum must be a number from 0 to 100')));

const invalidSchemaBaseline = {
  version: 2,
  include: [42],
  scopes: [{
    name: 'invalid-selector',
    selector: { prefixes: [42] },
    minimum: { lines: 90, statements: 90, functions: 90, branches: 90 }
  }]
};
const invalidSchema = checkCoverageSummary(fixtureSummary, invalidSchemaBaseline, { rootDir: fixtureRoot });
assert.ok(invalidSchema.failures.some((failure) => failure.includes('version must be 1')));
assert.ok(invalidSchema.failures.some((failure) => failure.includes('include entries must be non-empty strings')));
assert.ok(invalidSchema.failures.some((failure) => failure.includes('selector.prefixes must contain non-empty strings')));

const workflow = yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'));
const qualitySteps = workflow.jobs.quality.steps;
const coverageStep = qualitySteps.find((step) => step.name === 'Run coverage gate');
assert.ok(coverageStep.run.split(/\r?\n/).includes('npm run coverage 2>&1 | Tee-Object -FilePath coverage-output.log'));
const coverageArtifact = qualitySteps.find((step) => step.name === 'Upload coverage report');
assert.strictEqual(coverageArtifact.if, 'always()');
assert.ok(coverageArtifact.with.path.includes('coverage-summary.json'));
assert.ok(coverageArtifact.with.path.includes('baseline-check.json'));

console.log('coveragePolicy.test.js passed');

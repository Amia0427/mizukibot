'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const workflow = yaml.load(fs.readFileSync(
  path.resolve(__dirname, '../.github/workflows/ci.yml'),
  'utf8'
));

function findStep(job, predicate) {
  return job.steps.find(predicate);
}

assert.ok(!Object.hasOwn(workflow.on, 'pull_request_target'));
assert.strictEqual(workflow.permissions.contents, 'read');
assert.strictEqual(workflow.env.CI, 'true');
assert.strictEqual(workflow.env.AGENT_PROMPT_EXTRA_ROOTS, '');
assert.strictEqual(workflow.env.DATA_DIR, '${{ runner.temp }}/mizuki-data');
assert.strictEqual(workflow.env.MIZUKIBOT_ENV_FILE, '${{ runner.temp }}/mizukibot-ci.env');
assert.ok(workflow.concurrency.group);
assert.strictEqual(workflow.concurrency['cancel-in-progress'], true);

const quality = workflow.jobs.quality;
const linuxPolicy = workflow.jobs['linux-policy'];
assert.strictEqual(quality['runs-on'], 'windows-latest');
assert.strictEqual(quality['timeout-minutes'], 15);
assert.strictEqual(linuxPolicy['runs-on'], 'ubuntu-latest');

for (const job of [quality, linuxPolicy]) {
  const checkout = findStep(job, (step) => String(step.uses || '').startsWith('actions/checkout@'));
  const setupNode = findStep(job, (step) => String(step.uses || '').startsWith('actions/setup-node@'));
  assert.strictEqual(checkout.with['persist-credentials'], false);
  assert.strictEqual(setupNode.with['node-version-file'], '.nvmrc');
}

for (const command of [
  'npm ci',
  'npm run check:node',
  'npm run lint',
  'npm run typecheck',
  'npm run check:prompts',
  'npm run check:secrets:all',
  'npm audit --omit=dev'
]) {
  assert.ok(findStep(quality, (step) => step.run === command), `missing quality command: ${command}`);
}

const coverageStep = findStep(quality, (step) => step.name === 'Run coverage gate');
const harnessEvalStep = findStep(quality, (step) => step.name === 'Run versioned harness eval');
assert.strictEqual(harnessEvalStep.run, 'npm run eval:harness:ci');
assert.ok(quality.steps.indexOf(harnessEvalStep) < quality.steps.indexOf(coverageStep));
assert.strictEqual(coverageStep.shell, 'pwsh');
assert.ok(coverageStep.run.split(/\r?\n/).includes('npm run coverage 2>&1 | Tee-Object -FilePath coverage-output.log'));
assert.ok(coverageStep.run.split(/\r?\n/).includes('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'));

const failureArtifact = findStep(quality, (step) => step.name === 'Upload failed coverage log');
assert.strictEqual(failureArtifact.if, 'failure()');
assert.strictEqual(failureArtifact.with.path, 'coverage-output.log');
assert.strictEqual(failureArtifact.with['retention-days'], 7);

const coverageArtifact = findStep(quality, (step) => step.name === 'Upload coverage report');
assert.strictEqual(coverageArtifact.if, 'always()');
assert.ok(coverageArtifact.with.path.split(/\r?\n/).includes('artifacts/coverage/coverage-summary.json'));
assert.ok(coverageArtifact.with.path.split(/\r?\n/).includes('artifacts/coverage/baseline-check.json'));
assert.ok(coverageArtifact.with.path.split(/\r?\n/).includes('artifacts/coverage/lcov.info'));
assert.strictEqual(coverageArtifact.with['retention-days'], 7);

const linuxCheck = findStep(linuxPolicy, (step) => step.name === 'Check Node.js version and Linux scripts');
assert.ok(linuxCheck.run.split(/\r?\n/).includes(
  'bash -n scripts/bootstrap-debian12.sh scripts/install-linux.sh scripts/check-linux.sh'
));

console.log('CI workflow tests passed');

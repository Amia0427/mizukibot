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

const testStep = findStep(quality, (step) => step.name === 'Run tests');
assert.strictEqual(testStep.shell, 'pwsh');
assert.ok(testStep.run.split(/\r?\n/).includes('npm test 2>&1 | Tee-Object -FilePath test-output.log'));
assert.ok(testStep.run.split(/\r?\n/).includes('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'));

const artifactStep = findStep(quality, (step) => step.uses === 'actions/upload-artifact@v4');
assert.strictEqual(artifactStep.if, 'failure()');
assert.strictEqual(artifactStep.with.path, 'test-output.log');
assert.strictEqual(artifactStep.with['retention-days'], 7);

const linuxCheck = findStep(linuxPolicy, (step) => step.name === 'Check Node.js version and Linux scripts');
assert.ok(linuxCheck.run.split(/\r?\n/).includes(
  'bash -n scripts/bootstrap-debian12.sh scripts/install-linux.sh scripts/check-linux.sh'
));

console.log('CI workflow tests passed');

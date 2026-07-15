const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const projectRoot = path.resolve(__dirname, '..');
const lock = require('../package-lock.json');
const packageJson = require('../package.json');
const policy = require('../config/supply-chain-policy.json');
const {
  checkProductionLicenses
} = require('../scripts/check-production-licenses');
const {
  generateSbom,
  validateSbom
} = require('../scripts/generate-sbom');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectActionUses(value, uses = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectActionUses(item, uses);
    return uses;
  }
  if (!value || typeof value !== 'object') return uses;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'uses' && typeof item === 'string') uses.push(item);
    else collectActionUses(item, uses);
  }
  return uses;
}

const workflowsDir = path.join(projectRoot, '.github', 'workflows');
const approvedActionOwners = new Set(['actions', 'aquasecurity', 'github', 'gitleaks', 'google']);
for (const fileName of fs.readdirSync(workflowsDir).filter((item) => /\.ya?ml$/i.test(item))) {
  const source = fs.readFileSync(path.join(workflowsDir, fileName), 'utf8');
  const actionUses = collectActionUses(yaml.load(source));
  for (const actionUse of actionUses.filter((item) => !item.startsWith('./'))) {
    assert.match(actionUse, /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[a-f0-9]{40}$/, `${fileName}: ${actionUse}`);
    assert.ok(approvedActionOwners.has(actionUse.split('/')[0]), `${fileName}: unapproved action owner in ${actionUse}`);
  }
  for (const line of source.split(/\r?\n/).filter((item) => /^\s*uses:\s*[^.]/.test(item))) {
    assert.match(line, /@[a-f0-9]{40}\s+#\s+v\d/, `${fileName}: immutable action must retain a version comment`);
  }
}

const supplyChainWorkflowPath = path.join(workflowsDir, 'supply-chain.yml');
assert.strictEqual(fs.existsSync(supplyChainWorkflowPath), true, 'supply-chain workflow must exist');
const supplyChainWorkflow = yaml.load(fs.readFileSync(supplyChainWorkflowPath, 'utf8'));
assert.deepStrictEqual(supplyChainWorkflow.permissions, { contents: 'read' });
const sourceHistoryJob = supplyChainWorkflow.jobs?.['source-history'];
const dependencyPolicyJob = supplyChainWorkflow.jobs?.['dependency-policy'];
const dependencyVulnerabilityJob = supplyChainWorkflow.jobs?.['dependency-vulnerabilities'];
assert.ok(sourceHistoryJob && dependencyPolicyJob && dependencyVulnerabilityJob);
const sourceHistorySteps = sourceHistoryJob.steps || [];
const sourceCheckoutStep = sourceHistorySteps.find((item) => String(item.uses || '').startsWith('actions/checkout@'));
assert.deepStrictEqual(sourceCheckoutStep?.with, { 'fetch-depth': 0, 'persist-credentials': false });
const gitleaksStep = sourceHistorySteps.find((item) => String(item.uses || '').startsWith('gitleaks/gitleaks-action@'));
assert.strictEqual(gitleaksStep?.env?.GITHUB_TOKEN, '${{ github.token }}');
const dependencyPolicySteps = dependencyPolicyJob.steps || [];
assert.strictEqual(dependencyPolicyJob['timeout-minutes'], 15);
assert.ok(dependencyPolicySteps.some((item) => item.run === 'npm ci'));
assert.ok(dependencyPolicySteps.some((item) => String(item.run || '').includes('node scripts/check-production-licenses.js --json')));
assert.ok(dependencyPolicySteps.some((item) => String(item.run || '').includes('node scripts/generate-sbom.js')));
const policyArtifactStep = dependencyPolicySteps.find((item) => String(item.uses || '').startsWith('actions/upload-artifact@'));
assert.strictEqual(policyArtifactStep?.if, '${{ !cancelled() }}');
assert.strictEqual(policyArtifactStep?.with?.['retention-days'], 7);
assert.ok(String(policyArtifactStep?.with?.path || '').includes('artifacts/supply-chain'));
const dependencyVulnerabilitySteps = dependencyVulnerabilityJob.steps || [];
const osvStep = dependencyVulnerabilitySteps.find((item) => String(item.uses || '').startsWith('google/osv-scanner-action/osv-scanner-action@'));
assert.match(String(osvStep?.with?.['scan-args'] || ''), /--recursive[\s\S]*\.\//);
const osvArtifactStep = dependencyVulnerabilitySteps.find((item) => String(item.uses || '').startsWith('actions/upload-artifact@'));
assert.strictEqual(osvArtifactStep?.if, '${{ !cancelled() }}');
assert.strictEqual(osvArtifactStep?.with?.['retention-days'], 7);
for (const job of Object.values(supplyChainWorkflow.jobs || {})) {
  assert.ok((job.steps || []).every((item) => item['continue-on-error'] === undefined));
}

const current = checkProductionLicenses({
  lock,
  policy,
  now: new Date('2026-07-13T00:00:00.000Z')
});
assert.strictEqual(current.ok, true, current.errors.join('\n'));
assert.ok(current.packageCount > 300);
assert.ok(current.exceptionsUsed.includes('cycletls@2.0.5'));
assert.ok(current.overridesUsed.includes('json-bignum@0.0.3'));

const unknownLock = clone(lock);
unknownLock.packages['node_modules/unapproved-license'] = {
  version: '1.0.0',
  license: 'BUSL-1.1'
};
assert.ok(checkProductionLicenses({ lock: unknownLock, policy }).errors.some((item) => item.includes('BUSL-1.1')));

const missingVersionLock = clone(lock);
missingVersionLock.packages['node_modules/missing-version'] = { license: 'MIT' };
assert.ok(checkProductionLicenses({ lock: missingVersionLock, policy }).errors.some((item) => item.includes('missing-version')));

const versionDriftLock = clone(lock);
versionDriftLock.packages['node_modules/cycletls'].version = '2.0.6';
assert.ok(checkProductionLicenses({ lock: versionDriftLock, policy }).errors.some((item) => item.includes('cycletls@2.0.6')));

const expiredPolicy = clone(policy);
expiredPolicy.packageExceptions['cycletls@2.0.5'].reviewBy = '2026-01-01';
assert.ok(checkProductionLicenses({
  lock,
  policy: expiredPolicy,
  now: new Date('2026-07-13T00:00:00.000Z')
}).errors.some((item) => item.includes('expired')));

const missingReasonPolicy = clone(policy);
missingReasonPolicy.packageExceptions['cycletls@2.0.5'].reason = '';
assert.ok(checkProductionLicenses({ lock, policy: missingReasonPolicy }).errors.some((item) => item.includes('reason')));

const missingSourcePolicy = clone(policy);
missingSourcePolicy.packageLicenseOverrides['json-bignum@0.0.3'].source = '';
assert.ok(checkProductionLicenses({ lock, policy: missingSourcePolicy }).errors.some((item) => item.includes('source')));

const invalidSourcePolicy = clone(policy);
invalidSourcePolicy.packageLicenseOverrides['json-bignum@0.0.3'].source = 'upstream license';
assert.ok(checkProductionLicenses({ lock, policy: invalidSourcePolicy }).errors.some((item) => item.includes('HTTPS')));

const stalePolicy = clone(policy);
stalePolicy.packageExceptions['absent-package@1.0.0'] = {
  license: 'GPL-3.0-only',
  reason: 'test stale exception',
  reviewBy: '2026-12-01'
};
assert.ok(checkProductionLicenses({ lock, policy: stalePolicy }).errors.some((item) => item.includes('stale exception')));

const rootIdentityDocument = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  metadata: {
    component: {
      'bom-ref': `${packageJson.name}@${packageJson.version}`,
      name: packageJson.name,
      version: packageJson.version,
      purl: `pkg:npm/${packageJson.name}@${packageJson.version}`
    }
  },
  components: Object.keys(packageJson.dependencies).map((name) => ({ name })),
  dependencies: [{}]
};
const wrongRootRef = clone(rootIdentityDocument);
wrongRootRef.metadata.component['bom-ref'] = `other@${packageJson.version}`;
assert.strictEqual(validateSbom(wrongRootRef, packageJson).ok, false);
const wrongRootPurl = clone(rootIdentityDocument);
wrongRootPurl.metadata.component.purl = `pkg:npm/other@${packageJson.version}`;
assert.strictEqual(validateSbom(wrongRootPurl, packageJson).ok, false);
const workspaceNamedRoot = clone(rootIdentityDocument);
workspaceNamedRoot.metadata.component.name = 'workspace-directory';
assert.strictEqual(validateSbom(workspaceNamedRoot, packageJson).ok, true);

const sbomOutput = path.join(os.tmpdir(), `mizuki-sbom-${process.pid}-${Date.now()}.json`);
const generated = generateSbom({
  cwd: projectRoot,
  outputFile: sbomOutput,
  packageJson
});
assert.strictEqual(generated.ok, true);
assert.ok(generated.componentCount > 0);
assert.ok(generated.dependencyCount > 0);
assert.match(generated.sha256, /^[a-f0-9]{64}$/);
assert.strictEqual(fs.existsSync(sbomOutput), true);
const document = JSON.parse(fs.readFileSync(sbomOutput, 'utf8'));
const validated = validateSbom(document, packageJson);
assert.strictEqual(validated.ok, true, validated.errors.join('\n'));

const missingDirect = clone(document);
missingDirect.components = missingDirect.components.filter((item) => item.name !== Object.keys(packageJson.dependencies)[0]);
assert.strictEqual(validateSbom(missingDirect, packageJson).ok, false);

console.log('supplyChainPolicy.test.js passed');

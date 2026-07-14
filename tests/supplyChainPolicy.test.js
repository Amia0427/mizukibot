const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

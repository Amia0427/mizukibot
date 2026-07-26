#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function packageNameFromPath(packagePath) {
  return String(packagePath || '').split('node_modules/').filter(Boolean).at(-1) || '';
}

function collectProductionPackages(lock = {}) {
  return Object.entries(lock.packages || {})
    .filter(([packagePath, meta]) => packagePath && meta && meta.dev !== true && meta.link !== true)
    .map(([packagePath, meta]) => ({
      name: packageNameFromPath(packagePath),
      version: String(meta.version || '').trim(),
      license: String(meta.license || '').trim()
    }));
}

function checkProductionLicenses(options = {}) {
  const lock = options.lock || {};
  const policy = options.policy || {};
  const now = options.now instanceof Date ? options.now : new Date();
  const errors = [];
  const approved = new Set(Array.isArray(policy.approvedLicenseExpressions) ? policy.approvedLicenseExpressions : []);
  const exceptions = policy.packageExceptions && typeof policy.packageExceptions === 'object'
    ? policy.packageExceptions
    : {};
  const overrides = policy.packageLicenseOverrides && typeof policy.packageLicenseOverrides === 'object'
    ? policy.packageLicenseOverrides
    : {};
  const exceptionsUsed = new Set();
  const overridesUsed = new Set();
  const byLicense = {};

  if (policy.version !== 1) errors.push('policy version must be 1');
  if (approved.size === 0) errors.push('approvedLicenseExpressions must not be empty');

  const packages = collectProductionPackages(lock);
  for (const item of packages) {
    if (!item.version) {
      errors.push(`${item.name}: package version missing`);
      continue;
    }
    const packageKey = `${item.name}@${item.version}`;
    let license = item.license;
    if (!license) {
      const override = overrides[packageKey];
      if (!override) {
        errors.push(`${packageKey}: license missing and no override exists`);
        continue;
      }
      const source = String(override.source || '').trim();
      if (!URL.canParse(source) || new URL(source).protocol !== 'https:') {
        errors.push(`${packageKey}: license override source must be an HTTPS URL`);
      }
      license = String(override.license || '').trim();
      overridesUsed.add(packageKey);
    }
    byLicense[license] = (byLicense[license] || 0) + 1;
    if (approved.has(license)) continue;

    const exception = exceptions[packageKey];
    if (!exception || String(exception.license || '').trim() !== license) {
      errors.push(`${packageKey}: unapproved license expression ${license || '(missing)'}`);
      continue;
    }
    const reason = String(exception.reason || '').trim();
    const reviewBy = String(exception.reviewBy || '').trim();
    if (reason.length < 10) errors.push(`${packageKey}: exception reason is required`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) {
      errors.push(`${packageKey}: exception reviewBy must use YYYY-MM-DD`);
    } else if (reviewBy < now.toISOString().slice(0, 10)) {
      errors.push(`${packageKey}: exception expired on ${reviewBy}`);
    }
    exceptionsUsed.add(packageKey);
  }

  for (const packageKey of Object.keys(exceptions)) {
    if (!exceptionsUsed.has(packageKey)) errors.push(`${packageKey}: stale exception`);
  }
  for (const packageKey of Object.keys(overrides)) {
    if (!overridesUsed.has(packageKey)) errors.push(`${packageKey}: stale license override`);
  }

  return {
    ok: errors.length === 0,
    packageCount: packages.length,
    byLicense,
    exceptionsUsed: Array.from(exceptionsUsed).sort(),
    overridesUsed: Array.from(overridesUsed).sort(),
    errors
  };
}

function main(argv = process.argv.slice(2)) {
  const projectRoot = path.resolve(__dirname, '..');
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  const policy = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config', 'supply-chain-policy.json'), 'utf8'));
  const report = checkProductionLicenses({ lock, policy });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.ok) {
    console.log(`[licenses] passed: ${report.packageCount} production package entries`);
  } else {
    for (const error of report.errors) console.error(`[licenses] ${error}`);
  }
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (require.main === module) main();

module.exports = {
  checkProductionLicenses,
  collectProductionPackages,
  main,
  packageNameFromPath
};

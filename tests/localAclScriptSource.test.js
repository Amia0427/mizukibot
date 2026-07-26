'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'scripts', 'harden-local-acl.ps1');
const powershellCommand = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const powershellEnv = {
  ...process.env,
  PSModulePath: process.platform === 'win32'
    ? `${process.env.WINDIR}\\System32\\WindowsPowerShell\\v1.0\\Modules`
    : process.env.PSModulePath
};

assert.ok(fs.existsSync(scriptPath), 'ACL hardening script should exist');
const script = fs.readFileSync(scriptPath, 'utf8');
assert.match(script, /param\s*\(/i);
assert.match(script, /\[Parameter\(Mandatory\s*=\s*\$true\)\][\s\S]*ServiceIdentity/i);
assert.match(script, /\[switch\]\$Apply/i);
assert.match(script, /SetAccessRuleProtection\s*\(\$true\s*,\s*\$false\)/i);
assert.match(script, /ConvertTo-Json/i);
assert.doesNotMatch(script, /Remove-Item/i);

const serviceIdentityResult = spawnSync(powershellCommand, [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  '[System.Security.Principal.WindowsIdentity]::GetCurrent().Name'
], { cwd: root, encoding: 'utf8', env: powershellEnv });

if (serviceIdentityResult.error?.code === 'ENOENT' && process.platform !== 'win32') {
  console.log('localAclScriptSource.test.js skipped: PowerShell is unavailable');
  return;
}

assert.strictEqual(serviceIdentityResult.status, 0, serviceIdentityResult.stderr || serviceIdentityResult.stdout);
const serviceIdentity = serviceIdentityResult.stdout.trim();
assert.ok(serviceIdentity, 'the current Windows identity should be available for the preview test');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-local-acl-'));
const envPath = path.join(tempRoot, '.env');
const dataPath = path.join(tempRoot, 'data');
const snapshotPath = path.join(tempRoot, 'snapshots');
fs.writeFileSync(envPath, 'API_KEY=test-only\n', 'utf8');
fs.mkdirSync(dataPath);
fs.writeFileSync(path.join(dataPath, 'runtime.json'), '{}\n', 'utf8');

function getSddl(target) {
  const escaped = target.replace(/'/g, "''");
  const result = spawnSync(powershellCommand, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `(Get-Acl -LiteralPath '${escaped}').Sddl`
  ], { cwd: root, encoding: 'utf8', env: powershellEnv });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function getRuleSids(target) {
  const escaped = target.replace(/'/g, "''");
  const result = spawnSync(powershellCommand, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `@(Get-Acl -LiteralPath '${escaped}').Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | ConvertTo-Json -Compress`
  ], { cwd: root, encoding: 'utf8', env: powershellEnv });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const output = result.stdout.trim();
  return output ? (JSON.parse(output) instanceof Array ? JSON.parse(output) : [JSON.parse(output)]) : [];
}

const beforeEnvSddl = getSddl(envPath);
const beforeDataSddl = getSddl(dataPath);
const preview = spawnSync(powershellCommand, [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  scriptPath,
  '-RootPath',
  tempRoot,
  '-ServiceIdentity',
  serviceIdentity,
  '-SnapshotDirectory',
  snapshotPath
], { cwd: root, encoding: 'utf8', env: powershellEnv });

assert.strictEqual(preview.status, 0, preview.stderr || preview.stdout);
const report = JSON.parse(preview.stdout.trim());
assert.strictEqual(report.apply, false);
assert.strictEqual(report.serviceIdentity, serviceIdentity);
assert.deepStrictEqual(report.targets.map((target) => target.name), ['.env', 'data']);
assert.strictEqual(fs.existsSync(snapshotPath), false, 'preview must not create an ACL snapshot');
assert.strictEqual(getSddl(envPath), beforeEnvSddl, 'preview must not change .env ACL');
assert.strictEqual(getSddl(dataPath), beforeDataSddl, 'preview must not change data ACL');

const defaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-local-acl-default-'));
const defaultScriptsPath = path.join(defaultRoot, 'scripts');
const defaultScriptPath = path.join(defaultScriptsPath, 'harden-local-acl.ps1');
fs.mkdirSync(defaultScriptsPath);
fs.copyFileSync(scriptPath, defaultScriptPath);
fs.writeFileSync(path.join(defaultRoot, '.env'), 'API_KEY=test-only\n', 'utf8');
fs.mkdirSync(path.join(defaultRoot, 'data'));
const defaultPreview = spawnSync(powershellCommand, [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  defaultScriptPath,
  '-ServiceIdentity',
  serviceIdentity
], { cwd: root, encoding: 'utf8', env: powershellEnv });
assert.strictEqual(defaultPreview.status, 0, defaultPreview.stderr || defaultPreview.stdout);
assert.strictEqual(path.resolve(JSON.parse(defaultPreview.stdout.trim()).rootPath), defaultRoot);

const applyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-local-acl-apply-'));
const applyEnvPath = path.join(applyRoot, '.env');
const applyDataPath = path.join(applyRoot, 'data');
const applyChildPath = path.join(applyDataPath, 'nested.txt');
const applySnapshotPath = path.join(applyRoot, 'snapshots');
fs.writeFileSync(applyEnvPath, 'API_KEY=test-only\n', 'utf8');
fs.mkdirSync(applyDataPath);
fs.writeFileSync(applyChildPath, 'data\n', 'utf8');
const apply = spawnSync(powershellCommand, [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  scriptPath,
  '-RootPath',
  applyRoot,
  '-ServiceIdentity',
  serviceIdentity,
  '-SnapshotDirectory',
  applySnapshotPath,
  '-Apply'
], { cwd: root, encoding: 'utf8', env: powershellEnv });

assert.strictEqual(apply.status, 0, apply.stderr || apply.stdout);
const appliedReport = JSON.parse(apply.stdout.trim());
assert.strictEqual(appliedReport.apply, true);
assert.ok(appliedReport.snapshotPath);
assert.ok(fs.existsSync(appliedReport.snapshotPath));
for (const target of [applyEnvPath, applyDataPath, applyChildPath]) {
  const sids = getRuleSids(target);
  assert.ok(!sids.includes('S-1-5-11'), `${target} should not grant Authenticated Users`);
  assert.ok(!sids.includes('S-1-5-32-545'), `${target} should not grant BUILTIN\\Users`);
}

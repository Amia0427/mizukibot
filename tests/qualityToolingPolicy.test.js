'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ESLint } = require('eslint');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const typecheckConfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.check.json'), 'utf8'));

function getSeverity(ruleConfig) {
  return Array.isArray(ruleConfig) ? ruleConfig[0] : ruleConfig;
}

module.exports = (async () => {
  assert.strictEqual(packageJson.scripts.lint, 'eslint . --max-warnings=0 && node scripts/lint.js');
  assert.strictEqual(packageJson.scripts.typecheck, 'tsc -p tsconfig.check.json');

  const eslint = new ESLint({ cwd: root });
  assert.strictEqual(path.resolve(await eslint.findConfigFile()), path.join(root, 'eslint.config.js'));
  const representativeFile = path.join(root, 'core', 'router', 'index.js');
  const representativeConfig = await eslint.calculateConfigForFile(representativeFile);
  for (const ruleId of [
    'no-undef',
    'no-unreachable',
    'no-dupe-keys',
    'no-constant-binary-expression',
    'no-async-promise-executor'
  ]) {
    assert.strictEqual(getSeverity(representativeConfig.rules[ruleId]), 2, `${ruleId} must be an error`);
  }
  assert.strictEqual(getSeverity(representativeConfig.rules['no-unused-vars']), 0);

  const ruleProbes = new Map([
    ['no-undef', 'missingPolicyReference;'],
    ['no-unreachable', 'function policyProbe() { return; console.log("unreachable"); }'],
    ['no-dupe-keys', 'const policyProbe = { key: 1, key: 2 };'],
    ['no-constant-binary-expression', 'const policyProbe = 1 ?? 2;'],
    ['no-async-promise-executor', 'new Promise(async (resolve) => resolve());']
  ]);
  for (const [ruleId, source] of ruleProbes.entries()) {
    const [result] = await eslint.lintText(source, { filePath: representativeFile, warnIgnored: false });
    assert.ok(result.messages.some((message) => message.ruleId === ruleId), `${ruleId} must reject its probe`);
  }

  const chunkFile = path.join(root, 'core', 'dailyShareEngine.core.chunk.js');
  assert.strictEqual(await eslint.isPathIgnored(chunkFile), true);
  assert.strictEqual(await eslint.calculateConfigForFile(chunkFile), undefined);
  assert.strictEqual(await eslint.isPathIgnored(path.join(root, 'data', 'probe.js')), true);
  assert.strictEqual(await eslint.isPathIgnored(path.join(root, 'node_modules', 'probe.js')), true);
  assert.strictEqual(await eslint.isPathIgnored(representativeFile), false);
  const eslintConfig = await eslint.calculateConfigForFile(path.join(root, 'eslint.config.js'));
  assert.strictEqual(getSeverity(eslintConfig.rules['no-unused-vars']), 2);

  const checkedFiles = typecheckConfig.include;
  assert.ok(checkedFiles.length >= 10, 'stable typecheck boundary should remain meaningful');
  for (const relativePath of checkedFiles) {
    const absolutePath = path.join(root, relativePath);
    const fileConfig = await eslint.calculateConfigForFile(absolutePath);
    assert.strictEqual(getSeverity(fileConfig.rules['no-unused-vars']), 2, `${relativePath} must enforce unused-symbol cleanup`);
    const source = fs.readFileSync(absolutePath, 'utf8');
    assert.match(source, /^\/\/ @ts-check/m, `${relativePath} must opt into checkJs`);
    assert.ok(!/@ts-(?:ignore|nocheck)/.test(source), `${relativePath} must not bypass type checking`);
    assert.ok(!/@type\s*\{\s*any\s*\}/.test(source), `${relativePath} must not use JSDoc any`);
  }

  const [unusedProbe] = await eslint.lintText('const unusedPolicyValue = 1;', {
    filePath: path.join(root, checkedFiles[0]),
    warnIgnored: false
  });
  assert.ok(unusedProbe.messages.some((message) => message.ruleId === 'no-unused-vars'));

  console.log('qualityToolingPolicy.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

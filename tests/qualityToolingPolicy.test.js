'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const eslintConfigPath = path.join(root, 'eslint.config.js');
const eslintConfig = fs.readFileSync(eslintConfigPath, 'utf8');
const eslintRules = require(eslintConfigPath);
const typecheckConfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.check.json'), 'utf8'));

assert.match(packageJson.scripts.lint, /^eslint \. --max-warnings=0 && node scripts\/lint\.js$/);
assert.strictEqual(packageJson.scripts.typecheck, 'tsc -p tsconfig.check.json');
assert.match(eslintConfig, /'no-undef': 'error'/);
assert.match(eslintConfig, /'no-unreachable': 'error'/);
assert.match(eslintConfig, /'no-dupe-keys': 'error'/);
assert.match(eslintConfig, /'no-constant-binary-expression': 'error'/);
assert.match(eslintConfig, /'no-async-promise-executor': 'error'/);
assert.match(eslintConfig, /'no-unused-vars': \['error'/);
assert.match(eslintConfig, /'\*\*\/\*\.chunk\.js'/);

const checkedFiles = typecheckConfig.include;
const unusedBoundary = eslintRules.find((entry) => Array.isArray(entry.rules?.['no-unused-vars']));
assert.ok(unusedBoundary, 'stable unused-symbol boundary must exist');
assert.ok(checkedFiles.length >= 10, 'stable typecheck boundary should remain meaningful');
for (const relativePath of checkedFiles) {
  assert.ok(unusedBoundary.files.includes(relativePath), `${relativePath} must enforce unused-symbol cleanup`);
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  assert.match(source, /^\/\/ @ts-check/m, `${relativePath} must opt into checkJs`);
  assert.ok(!/@ts-(?:ignore|nocheck)/.test(source), `${relativePath} must not bypass type checking`);
  assert.ok(!/@type\s*\{\s*any\s*\}/.test(source), `${relativePath} must not use JSDoc any`);
}

console.log('qualityToolingPolicy.test.js passed');

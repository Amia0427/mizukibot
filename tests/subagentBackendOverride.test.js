const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'subagentExecutor.js'), 'utf8');

assert.ok(source.includes('resolveBackendNameForOptions'));
assert.ok(source.includes("const override = String(options?.backendOverride || '').trim().toLowerCase();"));
assert.ok(source.includes("if (resolveBackendNameForOptions(options) === 'openclaw')"));
assert.ok(source.includes('const backend = resolveBackendNameForOptions(params?.options);'));

console.log('subagentBackendOverride.test.js passed');

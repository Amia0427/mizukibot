const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sanitizeEnvValue,
  serializeEnvValue,
  setEnvPairs
} = require('../utils/envFile');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-file-test-'));
const envPath = path.join(tmpDir, '.env');

try {
  assert.strictEqual(sanitizeEnvValue('  keep spaces  '), '  keep spaces  ');
  assert.strictEqual(sanitizeEnvValue('a\nb\0c\rd'), 'a b c d');
  assert.strictEqual(serializeEnvValue('abc'), 'abc');
  assert.strictEqual(serializeEnvValue(''), '""');
  assert.strictEqual(serializeEnvValue('value # comment'), '"value # comment"');
  assert.strictEqual(serializeEnvValue('  keep spaces  '), '"  keep spaces  "');
  assert.strictEqual(serializeEnvValue('quote " and slash \\'), '"quote \\" and slash \\\\"');

  fs.writeFileSync(envPath, '# comment\nAPI_KEY=old\nOTHER=value\n', 'utf8');
  const output = setEnvPairs({
    API_KEY: 'new#secret',
    EMPTY_VALUE: '',
    SPACED_VALUE: '  a b  ',
    QUOTED_VALUE: 'say "hi"',
    BACKSLASH_VALUE: 'C:\\tmp\\x',
    MULTILINE_VALUE: 'a\nb\0c'
  }, envPath);

  assert.match(output, /^# comment$/m);
  assert.match(output, /^OTHER=value$/m);
  assert.match(output, /^API_KEY="new#secret"$/m);
  assert.match(output, /^EMPTY_VALUE=""$/m);
  assert.match(output, /^SPACED_VALUE="  a b  "$/m);
  assert.match(output, /^QUOTED_VALUE="say \\"hi\\""$/m);
  assert.match(output, /^BACKSLASH_VALUE="C:\\\\tmp\\\\x"$/m);
  assert.match(output, /^MULTILINE_VALUE="a b c"$/m);

  console.log('envFile.test.js passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

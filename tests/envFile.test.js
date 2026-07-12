const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveEnvPath,
  sanitizeEnvValue,
  serializeEnvValue,
  setEnvPairs
} = require('../utils/envFile');
const { loadLocalEnvFallback, resolveEnvironmentPath } = require('../config/envRuntime');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-file-test-'));
const envPath = path.join(tmpDir, '.env');
const originalEnvFile = process.env.MIZUKIBOT_ENV_FILE;
const testKey = 'MIZUKIBOT_ENV_FILE_TEST_VALUE';
const originalTestValue = process.env[testKey];

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

  const runtimeEnvPath = path.join(tmpDir, 'runtime.env');
  fs.writeFileSync(runtimeEnvPath, `${testKey}=loaded-from-runtime-file\n`, 'utf8');
  process.env.MIZUKIBOT_ENV_FILE = runtimeEnvPath;
  delete process.env[testKey];
  assert.strictEqual(resolveEnvPath(), runtimeEnvPath);
  assert.strictEqual(resolveEnvironmentPath(path.join(tmpDir, 'ignored-root')), runtimeEnvPath);
  loadLocalEnvFallback(path.join(tmpDir, 'ignored-root'));
  assert.strictEqual(process.env[testKey], 'loaded-from-runtime-file');
  setEnvPairs({ SAVED_TO_RUNTIME_FILE: 'yes' });
  assert.match(fs.readFileSync(runtimeEnvPath, 'utf8'), /^SAVED_TO_RUNTIME_FILE=yes$/m);

  console.log('envFile.test.js passed');
} finally {
  if (originalEnvFile === undefined) delete process.env.MIZUKIBOT_ENV_FILE;
  else process.env.MIZUKIBOT_ENV_FILE = originalEnvFile;
  if (originalTestValue === undefined) delete process.env[testKey];
  else process.env[testKey] = originalTestValue;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

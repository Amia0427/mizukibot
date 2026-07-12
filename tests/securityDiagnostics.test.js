const assert = require('assert');

const {
  collectSecurityDiagnostics,
  formatSecurityWarning,
  inspectApiBaseUrls,
  inspectNapCatReverseAuth,
  inspectSourceSecrets,
  inspectTokenPosture
} = require('../utils/securityDiagnostics');

const baseConfig = {
  WEB_BIND_HOST: '127.0.0.1',
  WEB_TOKEN: '',
  LOCAL_COMMAND_BRIDGE_ENABLED: true,
  LOCAL_COMMAND_BRIDGE_TOKEN: '',
  NAPCAT_HTTP_REVERSE_SECRET: 'reverse-secret',
  NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER: true,
  API_BASE_URL: 'https://api.example.com/v1'
};

const missingTokens = inspectTokenPosture(baseConfig);
assert.strictEqual(missingTokens.status, 'warn');
assert.strictEqual(missingTokens.webToken, 'missing');
assert.strictEqual(missingTokens.localCommandBridgeToken, 'missing');
assert.strictEqual(missingTokens.localCommandBridgeExecution, 'blocked');

const configuredTokens = inspectTokenPosture({
  ...baseConfig,
  WEB_TOKEN: 'web-token',
  LOCAL_COMMAND_BRIDGE_TOKEN: 'bridge-token'
});
assert.strictEqual(configuredTokens.status, 'ok');
assert.strictEqual(configuredTokens.localCommandBridgeExecution, 'available');

const publicBind = inspectTokenPosture({ ...baseConfig, WEB_BIND_HOST: '0.0.0.0' });
assert.ok(publicBind.findings.some((finding) => finding.id === 'web-token-missing-public-bind'));

const compatibleNapCatAuth = inspectNapCatReverseAuth({
  NAPCAT_HTTP_REVERSE_ENABLED: true,
  NAPCAT_HTTP_REVERSE_SECRET: 'reverse-secret',
  NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER: true
});
assert.strictEqual(compatibleNapCatAuth.status, 'warn');
assert.strictEqual(compatibleNapCatAuth.mode, 'signed-with-legacy-compatibility');
assert.ok(compatibleNapCatAuth.findings.some((finding) => finding.id === 'napcat-reverse-legacy-auth-enabled'));

const signedOnlyNapCatAuth = inspectNapCatReverseAuth({
  NAPCAT_HTTP_REVERSE_ENABLED: true,
  NAPCAT_HTTP_REVERSE_SECRET: 'reverse-secret',
  NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER: false
});
assert.strictEqual(signedOnlyNapCatAuth.status, 'ok');
assert.strictEqual(signedOnlyNapCatAuth.mode, 'signed-only');

const apiUrls = inspectApiBaseUrls({
  API_BASE_URL: 'https://api.example.com/v1',
  MEMORY_API_BASE_URL: 'http://127.0.0.1:9999',
  IMAGE_API_BASE_URL: 'http://192.168.1.10'
});
assert.strictEqual(apiUrls.status, 'warn');
assert.ok(apiUrls.findings.some((finding) => finding.id.includes('memory_api_base_url')));

const sourceSecrets = inspectSourceSecrets();
assert.strictEqual(sourceSecrets.status, 'ok');

const report = collectSecurityDiagnostics(baseConfig);
assert.strictEqual(report.status, 'warn');
assert.ok(report.summary.warn >= 1);
const secretReport = collectSecurityDiagnostics({
  ...baseConfig,
  WEB_TOKEN: 'super-secret-web-token',
  LOCAL_COMMAND_BRIDGE_TOKEN: 'super-secret-bridge-token',
  API_KEY: 'super-secret-api-key'
});
const secretJson = JSON.stringify(secretReport);
assert.ok(!secretJson.includes('super-secret-web-token'));
assert.ok(!secretJson.includes('super-secret-bridge-token'));
assert.ok(!secretJson.includes('super-secret-api-key'));

const warning = formatSecurityWarning(missingTokens.findings.find((finding) => finding.level === 'warn'));
assert.ok(warning.includes('Recommendation:'));

console.log('securityDiagnostics.test.js passed');

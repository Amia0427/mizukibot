const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.WEB_TOKEN = ' ';

const config = require('../config');
const { validateExternalApiBaseUrl } = require('../web/server');
const { collectSecurityDiagnostics } = require('../utils/securityDiagnostics');

assert.strictEqual(config.WEB_BIND_HOST, '127.0.0.1');
assert.strictEqual(config.WEB_TOKEN, '');

assert.strictEqual(validateExternalApiBaseUrl('API_BASE_URL', 'https://api.example.com/v1', { required: true }), '');
assert.match(validateExternalApiBaseUrl('API_BASE_URL', 'http://127.0.0.1:3000', { required: true }), /cannot point/);
assert.match(validateExternalApiBaseUrl('API_BASE_URL', 'http://localhost:3000', { required: true }), /cannot point/);
assert.match(validateExternalApiBaseUrl('API_BASE_URL', 'http://192.168.1.10', { required: true }), /cannot point/);
assert.match(validateExternalApiBaseUrl('API_BASE_URL', 'http://169.254.169.254', { required: true }), /cannot point/);
assert.match(validateExternalApiBaseUrl('API_BASE_URL', 'ftp://api.example.com', { required: true }), /must start/);
assert.match(validateExternalApiBaseUrl('API_BASE_URL', '', { required: true }), /cannot be empty/);
assert.strictEqual(validateExternalApiBaseUrl('AI_ROUTER_BASE_URL', ''), '');

const secretConfig = {
  ...config,
  WEB_TOKEN: 'secret-web-token',
  LOCAL_COMMAND_BRIDGE_TOKEN: 'secret-bridge-token',
  API_KEY: 'secret-api-key',
  API_BASE_URL: 'https://api.example.com/v1'
};
const statusPayload = collectSecurityDiagnostics(secretConfig);
const serialized = JSON.stringify(statusPayload);
assert.ok(!serialized.includes('secret-web-token'));
assert.ok(!serialized.includes('secret-bridge-token'));
assert.ok(!serialized.includes('secret-api-key'));
assert.ok(serialized.includes('configured'));

console.log('webSettingsSecurity.test.js passed');

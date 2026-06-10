const assert = require('assert');

const {
  getRetryDelayMs,
  isRetryableTransportError
} = require('../src/model/http/prepare.chunk');

const resetError = new Error('socket hang up');
resetError.code = 'ECONNRESET';
assert.strictEqual(isRetryableTransportError(resetError), true);
const fastDelay = getRetryDelayMs(resetError, 0);
assert.ok(fastDelay >= 80 && fastDelay < 120, `transport first retry should be fast, got ${fastDelay}`);

const serverError = new Error('upstream 500');
serverError.response = { status: 500 };
assert.strictEqual(isRetryableTransportError(serverError), false);
const normalDelay = getRetryDelayMs(serverError, 0);
assert.ok(normalDelay >= 300, `http status retry should keep normal backoff, got ${normalDelay}`);

const retryAfterError = new Error('rate limited');
retryAfterError.response = {
  status: 429,
  headers: {
    'retry-after': '1'
  }
};
assert.ok(getRetryDelayMs(retryAfterError, 0) >= 500, 'Retry-After must not use fast transport retry');

console.log('httpClientTransportRetryDelay.test.js passed');

const assert = require('assert');

const { __test } = require('../web/server');
const { createRuntimeReadiness } = require('../utils/runtimeReadiness');

function invoke(handler, readiness) {
  const response = {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  handler({}, response, readiness);
  return response;
}

const readiness = createRuntimeReadiness();
const startingLive = invoke(__test.handleLivenessRequest, readiness);
assert.strictEqual(startingLive.statusCode, 200);
assert.deepStrictEqual(startingLive.body, { ok: true });
assert.strictEqual(invoke(__test.handleReadinessRequest, readiness).statusCode, 503);
assert.strictEqual(invoke(__test.handleHealthRequest, readiness).statusCode, 503);

readiness.markReady();
assert.strictEqual(invoke(__test.handleLivenessRequest, readiness).statusCode, 200);
assert.strictEqual(invoke(__test.handleReadinessRequest, readiness).statusCode, 200);
assert.strictEqual(invoke(__test.handleHealthRequest, readiness).statusCode, 200);

readiness.beginDrain('test');
assert.strictEqual(invoke(__test.handleLivenessRequest, readiness).statusCode, 200);
assert.strictEqual(invoke(__test.handleReadinessRequest, readiness).statusCode, 503);
assert.strictEqual(invoke(__test.handleHealthRequest, readiness).statusCode, 503);

readiness.markStopped();
assert.strictEqual(invoke(__test.handleLivenessRequest, readiness).statusCode, 503);

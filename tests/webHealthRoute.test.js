const assert = require('assert');

const { __test } = require('../web/server');

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

__test.handleHealthRequest({}, response);

assert.strictEqual(response.statusCode, 200);
assert.deepStrictEqual(response.body, { ok: true });

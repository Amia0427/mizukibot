const assert = require('assert');

const { registerPromptRuntimeReloadRoute } = require('../web/promptRuntimeReloadRoute');

let registeredPath = '';
let registeredHandler = null;
const app = {
  post(path, handler) {
    registeredPath = path;
    registeredHandler = handler;
  }
};

registerPromptRuntimeReloadRoute(app, {
  reloadPromptSnapshot: () => ({ ok: true, version: '2026-08-17.2' })
});
assert.strictEqual(registeredPath, '/api/prompt-runtime/reload');
assert.strictEqual(typeof registeredHandler, 'function');

let responsePayload = null;
registeredHandler({}, {
  json(payload) {
    responsePayload = payload;
    return payload;
  }
});
assert.deepStrictEqual(responsePayload, { ok: true, version: '2026-08-17.2' });

let failureStatus = 0;
registerPromptRuntimeReloadRoute({
  post(path, handler) {
    registeredHandler = handler;
  }
}, {
  reloadPromptSnapshot: () => ({ ok: false, version: '2026-08-17.1', error: 'invalid manifest' })
});
registeredHandler({}, {
  status(code) {
    failureStatus = code;
    return this;
  },
  json(payload) {
    responsePayload = payload;
    return payload;
  }
});
assert.strictEqual(failureStatus, 503);
assert.deepStrictEqual(responsePayload, {
  ok: false,
  version: '2026-08-17.1',
  error: 'invalid manifest'
});

console.log('promptRuntimeReloadRoute.test.js passed');

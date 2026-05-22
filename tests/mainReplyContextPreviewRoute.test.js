const assert = require('assert');

const {
  parsePreviewLimit,
  registerMainReplyContextPreviewRoute
} = require('../web/mainReplyContextPreviewRoute');

assert.strictEqual(parsePreviewLimit(undefined), 12);
assert.strictEqual(parsePreviewLimit('0'), 12);
assert.strictEqual(parsePreviewLimit('1'), 1);
assert.strictEqual(parsePreviewLimit('99'), 50);

let registeredPath = '';
let registeredHandler = null;
const app = {
  get(path, handler) {
    registeredPath = path;
    registeredHandler = handler;
  }
};
const seenLimits = [];

registerMainReplyContextPreviewRoute(app, {
  buildMainReplyContextPreview: ({ limit }) => {
    seenLimits.push(limit);
    return { limit };
  }
});

assert.strictEqual(registeredPath, '/api/main-reply-context-preview');
assert.strictEqual(typeof registeredHandler, 'function');

let responsePayload = null;
registeredHandler({ query: {} }, {
  json(payload) {
    responsePayload = payload;
    return payload;
  }
});
assert.deepStrictEqual(responsePayload, { ok: true, preview: { limit: 12 } });

registeredHandler({ query: { limit: '99' } }, {
  json(payload) {
    responsePayload = payload;
    return payload;
  }
});
assert.deepStrictEqual(responsePayload, { ok: true, preview: { limit: 50 } });
assert.deepStrictEqual(seenLimits, [12, 50]);

console.log('mainReplyContextPreviewRoute.test.js passed');

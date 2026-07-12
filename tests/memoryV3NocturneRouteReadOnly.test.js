const assert = require('assert');

const { registerMemoryV3NocturneRoutes } = require('../web/memoryV3NocturneRoute');

const routes = new Map();
const app = {
  get(path, handler) {
    routes.set('GET ' + path, handler);
  },
  post(path, handler) {
    routes.set('POST ' + path, handler);
  }
};
const diagnosticCalls = [];

registerMemoryV3NocturneRoutes(app, {
  getProfileJournalDbDiagnostics(options) {
    diagnosticCalls.push(options);
    return { ok: true };
  },
  cleanProfileFacts() {
    return { ok: true };
  },
  cleanJournalEntries() {
    return { ok: true };
  }
});

function createResponse() {
  return {
    statusCode: 200,
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
}

const diagnosticsHandler = routes.get('GET /api/profile-journal-db/diagnostics');
assert.strictEqual(typeof diagnosticsHandler, 'function');

const response = createResponse();
diagnosticsHandler({
  query: {
    limit: '12',
    auto_clean: 'true'
  }
}, response);

assert.strictEqual(response.statusCode, 200);
assert.deepStrictEqual(diagnosticCalls, [{
  limit: 12,
  autoClean: false
}]);

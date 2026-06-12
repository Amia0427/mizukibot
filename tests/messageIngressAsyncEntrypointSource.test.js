const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  assert.ok(
    source.includes("require('./core/messageIngressDispatcher')"),
    'main entrypoint should load the async ingress dispatcher'
  );
  assert.ok(
    /messageIngressDispatcher\.enqueue\(msg,\s*\{\s*source\s*\}\)/.test(source),
    'main entrypoint should enqueue inbound messages instead of running the full handler inline'
  );
  assert.ok(
    /await\s+acceptIncomingMessage\(msg,\s*'napcat_ws'\)/.test(source),
    'websocket ingress should route through the async ingress acceptor'
  );
  assert.ok(
    /await\s+acceptIncomingMessage\(msg,\s*'napcat_http_reverse'\)/.test(source),
    'http reverse ingress should route through the async ingress acceptor'
  );

  console.log('messageIngressAsyncEntrypointSource.test.js passed');
})();

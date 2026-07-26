const assert = require('assert');

function loadPatcher({ actionSecret, reverseSecret }) {
  const modulePath = require.resolve('../scripts/configure-napcat-onebot');
  delete require.cache[modulePath];
  process.env.NAPCAT_HTTP_ACTION_SECRET = actionSecret;
  if (reverseSecret === undefined) {
    delete process.env.NAPCAT_HTTP_REVERSE_SECRET;
  } else {
    process.env.NAPCAT_HTTP_REVERSE_SECRET = reverseSecret;
  }
  return require(modulePath).patchOnebotConfig;
}

module.exports = (() => {
  const actionSecretBefore = process.env.NAPCAT_HTTP_ACTION_SECRET;
  const reverseSecretBefore = process.env.NAPCAT_HTTP_REVERSE_SECRET;
  const actionPortBefore = process.env.NAPCAT_HTTP_API_PORT;
  const reversePortBefore = process.env.NAPCAT_HTTP_REVERSE_PORT;
  try {
    process.env.NAPCAT_HTTP_API_PORT = '3100';
    process.env.NAPCAT_HTTP_REVERSE_PORT = '3102';
    const patchWithSeparateSecrets = loadPatcher({
      actionSecret: 'action-secret',
      reverseSecret: 'reverse-secret'
    });
    const unrelatedServer = {
      name: 'UnrelatedServer',
      enable: false,
      host: '0.0.0.0',
      port: 4100,
      token: 'unrelated-server-token'
    };
    const unrelatedClient = {
      name: 'UnrelatedClient',
      enable: false,
      url: 'http://127.0.0.1:4102',
      token: 'unrelated-client-token'
    };
    const separate = patchWithSeparateSecrets({
      network: {
        httpServers: [
          {
            name: 'ExistingActionServer',
            enable: false,
            host: '127.0.0.1',
            port: 3100,
            token: 'old-action-token'
          },
          unrelatedServer
        ],
        httpClients: [
          {
            name: 'ExistingReverseClient',
            enable: false,
            url: 'http://127.0.0.1:3102',
            token: 'old-reverse-token'
          },
          unrelatedClient
        ]
      }
    });
    assert.strictEqual(separate.network.httpServers[0].token, 'action-secret');
    assert.strictEqual(separate.network.httpClients[0].token, 'reverse-secret');
    assert.strictEqual(separate.network.httpServers[0].name, 'ExistingActionServer');
    assert.strictEqual(separate.network.httpClients[0].name, 'ExistingReverseClient');
    assert.deepStrictEqual(separate.network.httpServers[1], unrelatedServer);
    assert.deepStrictEqual(separate.network.httpClients[1], unrelatedClient);

    const patchWithFallbackSecret = loadPatcher({
      actionSecret: 'shared-secret',
      reverseSecret: undefined
    });
    const fallback = patchWithFallbackSecret({ network: {} });
    assert.strictEqual(fallback.network.httpServers[0].token, 'shared-secret');
    assert.strictEqual(fallback.network.httpClients[0].token, 'shared-secret');
  } finally {
    if (actionSecretBefore === undefined) delete process.env.NAPCAT_HTTP_ACTION_SECRET;
    else process.env.NAPCAT_HTTP_ACTION_SECRET = actionSecretBefore;
    if (reverseSecretBefore === undefined) delete process.env.NAPCAT_HTTP_REVERSE_SECRET;
    else process.env.NAPCAT_HTTP_REVERSE_SECRET = reverseSecretBefore;
    if (actionPortBefore === undefined) delete process.env.NAPCAT_HTTP_API_PORT;
    else process.env.NAPCAT_HTTP_API_PORT = actionPortBefore;
    if (reversePortBefore === undefined) delete process.env.NAPCAT_HTTP_REVERSE_PORT;
    else process.env.NAPCAT_HTTP_REVERSE_PORT = reversePortBefore;
    delete require.cache[require.resolve('../scripts/configure-napcat-onebot')];
  }

  console.log('configureNapcatOnebotSource.test.js passed');
})();

const express = require('express');
const config = require('../config');

function createNapCatHttpReverseServer(options = {}) {
  const handleMessage = options.handleMessage || (() => {});
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.post('/', async (req, res) => {
    const msg = req.body;
    if (!msg || typeof msg !== 'object') {
      return res.status(400).json({ error: 'invalid payload' });
    }

    res.status(204).end();

    setImmediate(async () => {
      try {
        await handleMessage(msg);
      } catch (e) {
        console.error('[HTTP reverse message handler error]', e?.message || e);
      }
    });
  });

  return app;
}

function startNapCatHttpReverseServer(options = {}) {
  const app = createNapCatHttpReverseServer(options);
  const port = config.NAPCAT_HTTP_REVERSE_PORT;
  const host = config.NAPCAT_HTTP_REVERSE_BIND_HOST || '127.0.0.1';

  const server = app.listen(port, host, () => {
    console.log(`[NapCat HTTP Reverse] listening on http://${host}:${port}`);
  });

  return server;
}

module.exports = {
  createNapCatHttpReverseServer,
  startNapCatHttpReverseServer
};

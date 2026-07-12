const express = require('express');
const crypto = require('crypto');
const config = require('../config');

function secureEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''), 'utf8');
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function readRequestSecret(req) {
  const directSecret = String(req.headers['x-napcat-token'] || '').trim();
  if (directSecret) return directSecret;
  const authorization = String(req.headers.authorization || '').trim();
  return /^Bearer\s+/i.test(authorization)
    ? authorization.replace(/^Bearer\s+/i, '').trim()
    : '';
}

function createNapCatHttpReverseServer(options = {}) {
  const handleMessage = options.handleMessage || (() => {});
  const secret = String(options.secret ?? config.NAPCAT_HTTP_REVERSE_SECRET ?? '').trim();
  if (!secret) {
    throw new Error('NAPCAT_HTTP_REVERSE_SECRET is required');
  }
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.post('/', async (req, res) => {
    if (!secureEqual(readRequestSecret(req), secret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

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

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const NAPCAT_EVENT_TYPES = new Set(['message', 'message_sent', 'notice', 'request', 'meta_event']);

function secureEqual(actualBuffer, expectedBuffer) {
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function secureEqualText(actual, expected) {
  return secureEqual(
    Buffer.from(String(actual || ''), 'utf8'),
    Buffer.from(String(expected || ''), 'utf8')
  );
}

function readHeader(req, name) {
  return String(req.headers[name] || '').trim();
}

function parseTimestamp(value) {
  if (!/^\d{10,13}$/.test(value)) return NaN;
  const timestamp = Number(value);
  return value.length === 10 ? timestamp * 1000 : timestamp;
}

function readSignature(value) {
  const normalized = value.replace(/^sha256=/i, '');
  return /^[a-f0-9]{64}$/i.test(normalized)
    ? Buffer.from(normalized, 'hex')
    : null;
}

function readLegacyToken(req) {
  const directToken = readHeader(req, 'x-napcat-token');
  if (directToken) return directToken;
  const authorization = readHeader(req, 'authorization');
  return /^Bearer\s+/i.test(authorization)
    ? authorization.replace(/^Bearer\s+/i, '').trim()
    : '';
}

function createAuthenticator({ secret, maxAgeMs, now, nonceCache, allowLegacyBearer }) {
  return (req) => {
    const timestampHeader = readHeader(req, 'x-napcat-timestamp');
    const nonce = readHeader(req, 'x-napcat-nonce');
    const signatureHeader = readHeader(req, 'x-napcat-signature');
    if (!timestampHeader && !nonce && !signatureHeader) {
      const legacyToken = readLegacyToken(req);
      return allowLegacyBearer && secureEqualText(legacyToken, secret)
        ? { ok: true, legacy: true }
        : { ok: false, status: 401, error: 'Unauthorized' };
    }

    if (!Buffer.isBuffer(req.rawBody)) {
      return { ok: false, status: 415, error: 'JSON body required' };
    }
    const timestamp = parseTimestamp(timestampHeader);
    const signature = readSignature(signatureHeader);
    const currentTime = now();

    if (!Number.isFinite(timestamp) || Math.abs(currentTime - timestamp) > maxAgeMs) {
      return { ok: false, status: 401, error: 'Invalid timestamp' };
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !signature) {
      return { ok: false, status: 401, error: 'Invalid signature' };
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(timestampHeader)
      .update('.')
      .update(nonce)
      .update('.')
      .update(req.rawBody)
      .digest();
    if (!secureEqual(signature, expected)) {
      return { ok: false, status: 401, error: 'Invalid signature' };
    }

    for (const [cachedNonce, expiresAt] of nonceCache) {
      if (expiresAt <= currentTime) nonceCache.delete(cachedNonce);
    }
    if (nonceCache.has(nonce)) {
      return { ok: false, status: 409, error: 'Replay detected' };
    }
    nonceCache.set(nonce, currentTime + maxAgeMs);
    return { ok: true };
  };
}

function createRateLimiter({ windowMs, maxRequests, now }) {
  const clients = new Map();
  return (req, res, next) => {
    const currentTime = now();
    for (const [clientKey, state] of clients) {
      if (state.resetAt <= currentTime) clients.delete(clientKey);
    }
    const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
    const current = clients.get(clientKey);
    const state = !current || current.resetAt <= currentTime
      ? { count: 0, resetAt: currentTime + windowMs }
      : current;
    state.count += 1;
    clients.set(clientKey, state);

    if (state.count > maxRequests) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((state.resetAt - currentTime) / 1000))));
      return res.status(429).json({ error: 'Too many requests' });
    }
    return next();
  };
}

function isValidEvent(payload) {
  return payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && typeof payload.post_type === 'string'
    && NAPCAT_EVENT_TYPES.has(payload.post_type);
}

function createNapCatHttpReverseServer(options = {}) {
  const handleMessage = options.handleMessage || (() => {});
  const secret = String(options.secret ?? config.NAPCAT_HTTP_REVERSE_SECRET ?? '').trim();
  if (!secret) {
    throw new Error('NAPCAT_HTTP_REVERSE_SECRET is required');
  }
  const maxBodyBytes = Math.max(1024, Number(options.maxBodyBytes ?? config.NAPCAT_HTTP_REVERSE_MAX_BODY_BYTES));
  const signatureMaxAgeMs = Math.max(1000, Number(options.signatureMaxAgeMs ?? config.NAPCAT_HTTP_REVERSE_SIGNATURE_MAX_AGE_MS));
  const rateLimitWindowMs = Math.max(1000, Number(options.rateLimitWindowMs ?? config.NAPCAT_HTTP_REVERSE_RATE_LIMIT_WINDOW_MS));
  const rateLimitMax = Math.max(1, Number(options.rateLimitMax ?? config.NAPCAT_HTTP_REVERSE_RATE_LIMIT_MAX));
  const allowLegacyBearer = options.allowLegacyBearer ?? config.NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER;
  const trustProxy = options.trustProxy ?? config.NAPCAT_HTTP_REVERSE_TRUST_PROXY;
  const now = options.now || Date.now;
  const authenticate = createAuthenticator({
    secret,
    maxAgeMs: signatureMaxAgeMs,
    now,
    nonceCache: new Map(),
    allowLegacyBearer
  });
  const rateLimit = createRateLimiter({
    windowMs: rateLimitWindowMs,
    maxRequests: rateLimitMax,
    now
  });
  const app = express();

  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');
  app.use(express.json({
    limit: maxBodyBytes,
    verify(req, _res, buffer) {
      req.rawBody = buffer;
    }
  }));

  app.post('/', async (req, res) => {
    const authResult = authenticate(req);
    if (!authResult.ok) {
      return res.status(authResult.status).json({ error: authResult.error });
    }

    return rateLimit(req, res, () => {
      const msg = req.body;
      if (!isValidEvent(msg)) {
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
  });

  app.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Payload too large' });
    }
    if (error instanceof SyntaxError && error.status === 400) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    return next(error);
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

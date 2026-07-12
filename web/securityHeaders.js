const crypto = require('crypto');

function normalizeIp(value) {
  return String(value || '').trim().replace(/^::ffff:/, '');
}

function isLoopbackIp(value) {
  const ip = normalizeIp(value);
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function getTrustedForwardedValue(headerValue, trustProxyHops) {
  const hops = Math.max(0, Math.floor(Number(trustProxyHops) || 0));
  if (hops < 1) return '';
  const values = String(headerValue || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return '';
  return values[Math.max(0, values.length - hops)] || '';
}

function isRequestSecure(req, options = {}) {
  if (req.socket?.encrypted || req.connection?.encrypted) return true;
  if (!isLoopbackIp(req.socket?.remoteAddress)) return false;
  const forwardedProto = getTrustedForwardedValue(
    req.headers?.['x-forwarded-proto'],
    options.trustProxyHops
  );
  return forwardedProto.toLowerCase() === 'https';
}

function createSecurityHeaders(options = {}) {
  return (req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals = res.locals || {};
    res.locals.cspNonce = nonce;
    res.setHeader('Content-Security-Policy', [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'self'",
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'"
    ].join('; '));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (isRequestSecure(req, options)) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

module.exports = {
  createSecurityHeaders,
  getTrustedForwardedValue,
  isLoopbackIp,
  isRequestSecure
};

const config = require('../config');

function getClientIp(req) {
  const socketIp = String(req.socket?.remoteAddress || '').trim().replace(/^::ffff:/, '');
  if (socketIp) return socketIp;
  const raw = String(req.headers['x-forwarded-for'] || '');
  return raw.split(',')[0].trim().replace(/^::ffff:/, '');
}

function isLocalIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '';
}

function isLocalBindHost(host) {
  return isLocalIp(String(host || '').trim().replace(/^::ffff:/, ''));
}

function isTokenlessLocalWebAllowed(host) {
  return Boolean(config.WEB_LOCAL_ONLY_WITHOUT_TOKEN) && isLocalBindHost(host || config.WEB_BIND_HOST || '127.0.0.1');
}

function isTrustedLocalOrigin(req, host, port) {
  const refs = [req.headers.origin, req.headers.referer].filter(Boolean);
  for (const raw of refs) {
    try {
      const u = new URL(String(raw));
      const h = String(u.hostname || '').trim();
      const p = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      if (isLocalIp(h) && p === Number(port)) return true;
      if (isLocalIp(h) && (host === '127.0.0.1' || host === 'localhost' || host === '::1')) return true;
    } catch (_) {}
  }
  return false;
}

function checkWebAuth(req, options = {}) {
  const token = String(config.WEB_TOKEN || '').trim();
  if (!token) {
    const host = options.host || config.WEB_BIND_HOST || '127.0.0.1';
    if (!isTokenlessLocalWebAllowed(host)) return false;
    if (!isLocalIp(getClientIp(req))) return false;
    const method = String(req.method || 'GET').toUpperCase();
    // Require same-origin browser context for local unsafe actions.
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    return isTrustedLocalOrigin(req, host, options.port || 3005);
  }

  const xWebToken = String(req.headers['x-web-token'] || '').trim();
  if (xWebToken && xWebToken === token) return true;

  const authHeader = String(req.headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(authHeader)) {
    const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (bearerToken === token) return true;
  }

  return false;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  checkWebAuth,
  escapeHtml,
  getClientIp,
  isLocalBindHost,
  isLocalIp,
  isTokenlessLocalWebAllowed,
  isTrustedLocalOrigin
};

// @ts-check
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const { isRequestSecure } = require('./securityHeaders');

const SESSION_COOKIE_NAME = 'mizuki_web_session';

function normalizeIp(value) {
  return String(value || '').trim().replace(/^::ffff:/, '');
}

function isLocalIp(ip) {
  const normalized = normalizeIp(ip);
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function getClientIp(req, options = {}) {
  const socketIp = normalizeIp(req.socket?.remoteAddress);
  const trustProxyHops = Math.max(0, Math.floor(Number(options.trustProxyHops) || 0));
  if (trustProxyHops < 1 || !isLocalIp(socketIp)) return socketIp;

  const forwarded = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map(normalizeIp)
    .filter(Boolean);
  const chain = [...forwarded, socketIp].filter(Boolean);
  if (chain.length === 0) return '';
  return chain[Math.max(0, chain.length - trustProxyHops - 1)] || socketIp;
}

function isLocalBindHost(host) {
  return isLocalIp(host);
}

function isTokenlessLocalWebAllowed(host) {
  return Boolean(config.WEB_LOCAL_ONLY_WITHOUT_TOKEN) && isLocalBindHost(host || config.WEB_BIND_HOST || '127.0.0.1');
}

function getRequestOrigin(req, options = {}) {
  const host = String(req.headers?.host || '').trim();
  if (!host) return '';
  const protocol = isRequestSecure(req, options) ? 'https' : 'http';
  return `${protocol}://${host}`;
}

function isStrictSameOrigin(req, options = {}) {
  const rawSource = String(req.headers?.origin || req.headers?.referer || '').trim();
  if (!rawSource) return false;
  try {
    return new URL(rawSource).origin === getRequestOrigin(req, options);
  } catch (_) {
    return false;
  }
}

function isTrustedLocalOrigin(req, host, port) {
  const expectedHost = String(host || '').includes(':') ? `[${host}]` : host;
  const expectedOrigin = `http://${expectedHost}:${Number(port)}`;
  const rawSource = String(req.headers?.origin || req.headers?.referer || '').trim();
  if (!rawSource) return false;
  try {
    return new URL(rawSource).origin === expectedOrigin;
  } catch (_) {
    return false;
  }
}

function getSessionId(req) {
  const cookieHeader = String(req.headers?.cookie || '');
  const values = [];
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    values.push(part.slice(separator + 1).trim());
  }
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0])) return '';
  return values[0];
}

function checkWebAuth(req, options = {}) {
  const sessionId = getSessionId(req);
  if (sessionId && options.sessionManager?.has(sessionId)) return true;

  const token = String(config.WEB_TOKEN || '').trim();
  if (token) return false;

  const host = options.host || config.WEB_BIND_HOST || '127.0.0.1';
  if (!isTokenlessLocalWebAllowed(host)) return false;
  if (!isLocalIp(getClientIp(req, options))) return false;
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  return isTrustedLocalOrigin(req, host, options.port || 3005);
}

function resolveWebTokenRole(candidate, options = {}) {
  const adminToken = options.adminToken ?? config.WEB_TOKEN;
  const viewerToken = options.viewerToken ?? config.WEB_VIEWER_TOKEN;
  if (verifyWebToken(candidate, adminToken)) return 'admin';
  if (verifyWebToken(candidate, viewerToken)) return 'viewer';
  return '';
}

function getWebSessionRole(req, options = {}) {
  const sessionRole = options.sessionManager?.getRole?.(getSessionId(req));
  if (sessionRole) return sessionRole;
  const host = options.host || config.WEB_BIND_HOST || '127.0.0.1';
  return !String(config.WEB_TOKEN || '').trim() && isTokenlessLocalWebAllowed(host) && isLocalIp(getClientIp(req, options))
    ? 'admin'
    : '';
}

function verifyWebToken(candidate, expected = config.WEB_TOKEN) {
  const normalizedCandidate = String(candidate || '');
  const normalizedExpected = String(expected || '').trim();
  if (!normalizedCandidate || !normalizedExpected) return false;
  const candidateDigest = crypto.createHash('sha256').update(normalizedCandidate).digest();
  const expectedDigest = crypto.createHash('sha256').update(normalizedExpected).digest();
  return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}

function createLoginRateLimiter(options = {}) {
  const windowMs = Math.max(1000, Number(options.windowMs) || 5 * 60 * 1000);
  const maxAttempts = Math.max(1, Math.floor(Number(options.maxAttempts) || 5));
  const maxClients = Math.max(1, Math.floor(Number(options.maxClients) || 1000));
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const stateFile = String(options.stateFile || '').trim();
  const clients = new Map();

  function persist() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(path.resolve(stateFile)), { recursive: true });
      fs.writeFileSync(path.resolve(stateFile), JSON.stringify({ version: 1, clients: Object.fromEntries(clients) }), 'utf8');
    } catch (_) {}
  }

  function load() {
    if (!stateFile) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(stateFile), 'utf8'));
      const source = parsed && typeof parsed.clients === 'object' ? parsed.clients : {};
      for (const [key, entry] of Object.entries(source)) {
        const count = Number(entry?.count);
        const resetAt = Number(entry?.resetAt);
        if (key && Number.isFinite(count) && count > 0 && Number.isFinite(resetAt) && resetAt > now()) {
          clients.set(key, { count: Math.floor(count), resetAt });
        }
      }
    } catch (_) {}
  }

  function clearExpired() {
    const currentTime = now();
    let changed = false;
    for (const [key, entry] of clients) {
      if (entry.resetAt <= currentTime) {
        clients.delete(key);
        changed = true;
      }
    }
    if (changed) persist();
  }

  function ensureCapacity(key) {
    clearExpired();
    if (clients.has(key)) return;
    while (clients.size >= maxClients) {
      const oldestKey = clients.keys().next().value;
      if (!oldestKey) break;
      clients.delete(oldestKey);
      persist();
    }
  }

  function check(clientKey) {
    const key = String(clientKey || 'unknown');
    clearExpired();
    const entry = clients.get(key);
    if (!entry || entry.count < maxAttempts) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now()) / 1000))
    };
  }

  function recordFailure(clientKey) {
    const key = String(clientKey || 'unknown');
    ensureCapacity(key);
    const entry = clients.get(key);
    if (entry) {
      entry.count += 1;
      persist();
      return;
    }
    clients.set(key, { count: 1, resetAt: now() + windowMs });
    persist();
  }

  load();

  return {
    check,
    clearExpired,
    recordFailure,
    reset: (clientKey) => {
      const deleted = clients.delete(String(clientKey || 'unknown'));
      if (deleted) persist();
      return deleted;
    },
    size: () => clients.size
  };
}

function buildSessionCookie(id, ttlMs, secure) {
  const maxAge = Math.max(1, Math.floor(Number(ttlMs) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${id}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : ''
  ].filter(Boolean).join('; ');
}

function buildExpiredSessionCookie(secure) {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : ''
  ].filter(Boolean).join('; ');
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
  SESSION_COOKIE_NAME,
  buildExpiredSessionCookie,
  buildSessionCookie,
  checkWebAuth,
  createLoginRateLimiter,
  escapeHtml,
  getClientIp,
  getWebSessionRole,
  getRequestOrigin,
  getSessionId,
  isLocalBindHost,
  isLocalIp,
  isStrictSameOrigin,
  isTokenlessLocalWebAllowed,
  isTrustedLocalOrigin,
  resolveWebTokenRole,
  verifyWebToken
};

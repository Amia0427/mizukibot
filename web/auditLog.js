const path = require('path');
const { appendFileWithRotation } = require('../utils/logRotation');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function maskClientIp(value = '') {
  const ip = normalizeText(value);
  if (!ip) return '';
  if (ip.includes(':')) return '[redacted-ipv6]';
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : '[redacted-ip]';
}

function createWebAuditLogger(options = {}) {
  const filePath = normalizeText(options.filePath);

  function record(event = {}) {
    if (!filePath) return false;
    const payload = {
      at: new Date().toISOString(),
      actor: normalizeText(event.actor) || 'unknown',
      role: normalizeText(event.role) || 'unknown',
      method: normalizeText(event.method).toUpperCase(),
      path: normalizeText(event.path),
      status: Number.isFinite(Number(event.status)) ? Number(event.status) : 0,
      clientIp: maskClientIp(event.clientIp),
      action: normalizeText(event.action)
    };
    try {
      const resolved = path.resolve(filePath);
      appendFileWithRotation(resolved, `${JSON.stringify(payload)}\n`);
      return true;
    } catch (_) {
      return false;
    }
  }

  return { record };
}

module.exports = {
  createWebAuditLogger,
  maskClientIp
};

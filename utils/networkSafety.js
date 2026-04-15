const net = require('net');

function normalizeHost(hostname = '') {
  return String(hostname || '').trim().toLowerCase();
}

function isPrivateIpv4(host) {
  const parts = host.split('.').map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = parts;
  // Cover loopback/private/link-local/CGNAT/benchmarking blocks.
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

function isPrivateIpv6(host) {
  const h = normalizeHost(host);
  if (!h) return true;
  if (h === '::1' || h === '::') return true;
  // Unique local fc00::/7 and link-local fe80::/10.
  if (/^f[cd][0-9a-f]*:/i.test(h)) return true;
  if (/^fe[89ab][0-9a-f]*:/i.test(h)) return true;
  return false;
}

function isUnsafeHost(hostname = '') {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // Block well-known metadata hosts to reduce cloud SSRF risk.
  const metadataHosts = new Set([
    'metadata.google.internal',
    'metadata.aliyun.internal',
    'metadata.tencentyun.com',
    'metadata',
    '169.254.169.254',
    '100.100.100.200'
  ]);
  if (metadataHosts.has(host)) return true;

  const ipType = net.isIP(host);
  if (ipType === 4) return isPrivateIpv4(host);
  if (ipType === 6) return isPrivateIpv6(host);
  return false;
}

function isUnsafeHttpUrl(rawUrl = '') {
  let parsed = null;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch (_) {
    return true;
  }

  if (!/^https?:$/i.test(parsed.protocol)) return true;
  return isUnsafeHost(parsed.hostname);
}

module.exports = {
  isUnsafeHost,
  isUnsafeHttpUrl
};

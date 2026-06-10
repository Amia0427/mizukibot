const dns = require('dns');
const net = require('net');

function normalizeHost(hostname = '') {
  return String(hostname || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/g, '')
    .toLowerCase();
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
  const mappedIpv4 = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4[1]);
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

function parseHttpUrl(rawUrl = '') {
  let parsed = null;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch (_) {
    return null;
  }
  if (!/^https?:$/i.test(parsed.protocol)) return null;
  return parsed;
}

function normalizeResolvedAddressEntry(entry = null) {
  const address = normalizeHost(entry && entry.address ? entry.address : entry);
  if (!address) return null;
  const family = Number(entry && entry.family ? entry.family : net.isIP(address));
  return {
    address,
    family: family === 6 ? 6 : 4
  };
}

function splitSafeResolvedAddresses(addresses = []) {
  const normalized = (Array.isArray(addresses) ? addresses : [addresses])
    .map(normalizeResolvedAddressEntry)
    .filter(Boolean);
  return {
    all: normalized,
    safe: normalized.filter((entry) => !isUnsafeHost(entry.address)),
    unsafe: normalized.filter((entry) => isUnsafeHost(entry.address))
  };
}

function isUnsafeHttpUrl(rawUrl = '') {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return true;
  return isUnsafeHost(parsed.hostname);
}

async function resolveSafeHttpUrl(rawUrl = '', options = {}) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) throw new Error('URL must use http or https');

  const hostname = normalizeHost(parsed.hostname);
  if (isUnsafeHost(hostname)) throw new Error('URL host is not allowed');

  const lookup = typeof options.lookup === 'function'
    ? options.lookup
    : dns.promises.lookup.bind(dns.promises);
  const addresses = await lookup(hostname, { all: true });
  const resolved = splitSafeResolvedAddresses(addresses);
  if (!resolved.all.length) throw new Error('URL host could not be resolved');

  if (resolved.unsafe.length > 0 && options.allowMixedResolvedAddresses !== true) {
    throw new Error('URL resolves to a disallowed address');
  }
  if (!resolved.safe.length) throw new Error('URL resolves only to disallowed addresses');

  return {
    url: parsed,
    hostname,
    safeAddresses: resolved.safe,
    unsafeAddresses: resolved.unsafe
  };
}

async function assertSafeHttpUrl(rawUrl = '', options = {}) {
  const result = await resolveSafeHttpUrl(rawUrl, options);
  return result.url;
}

function isLoopbackHost(hostname = '') {
  const host = normalizeHost(hostname);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

async function assertSafeModelEndpoint(rawUrl = '', options = {}) {
  const result = await resolveSafeModelEndpoint(rawUrl, options);
  return result.url;
}

async function resolveSafeModelEndpoint(rawUrl = '', options = {}) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) throw new Error('endpoint must use http or https');

  const allowLocalHttp = Boolean(options.allowLocalHttp);
  if (parsed.protocol === 'http:') {
    if (!allowLocalHttp || !isLoopbackHost(parsed.hostname)) {
      throw new Error('endpoint must use https');
    }
    return {
      url: parsed,
      hostname: normalizeHost(parsed.hostname),
      safeAddresses: [],
      unsafeAddresses: []
    };
  }

  return resolveSafeHttpUrl(rawUrl, {
    ...options,
    allowMixedResolvedAddresses: options.allowMixedResolvedAddresses !== false
  });
}

module.exports = {
  assertSafeHttpUrl,
  assertSafeModelEndpoint,
  resolveSafeHttpUrl,
  resolveSafeModelEndpoint,
  isUnsafeHost,
  isUnsafeHttpUrl
};

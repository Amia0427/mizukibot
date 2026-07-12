const fs = require('fs');
const path = require('path');

const { isUnsafeHttpUrl } = require('./networkSafety');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LEAKED_TOKEN_PARTS = ['FUcQwzRjozCZIAp', 'UYZyd-B4zjkXj0Ief80_i618xH8Q'];
const API_BASE_KEYS = [
  'API_BASE_URL',
  'AI_FALLBACK_API_BASE_URL',
  'AI_ROUTER_BASE_URL',
  'MEMORY_API_BASE_URL',
  'IMAGE_API_BASE_URL',
  'ADMIN_API_BASE_URL',
  'ADMIN_AI_FALLBACK_API_BASE_URL',
  'ADMIN_IMAGE_API_BASE_URL',
  'VISION_CAPTION_WORKER_API_BASE_URL',
  'MC_API_BASE_URL'
];

function normalizeText(value = '') {
  return String(value || '').trim();
}

function isConfigured(value) {
  return normalizeText(value) !== '';
}

function makeFinding(id, level, title, detail, recommendation = '') {
  return { id, level, title, detail, recommendation };
}

function rankLevel(level) {
  if (level === 'error') return 3;
  if (level === 'warn') return 2;
  return 1;
}

function summarizeLevel(findings = []) {
  const max = findings.reduce((current, finding) => Math.max(current, rankLevel(finding.level)), 1);
  if (max >= 3) return 'error';
  if (max >= 2) return 'warn';
  return 'ok';
}

function inspectTokenPosture(config = {}) {
  const findings = [];
  const webTokenConfigured = isConfigured(config.WEB_TOKEN);
  const bridgeTokenConfigured = isConfigured(config.LOCAL_COMMAND_BRIDGE_TOKEN);
  const webBindHost = normalizeText(config.WEB_BIND_HOST || '127.0.0.1') || '127.0.0.1';
  const bridgeEnabled = config.LOCAL_COMMAND_BRIDGE_ENABLED !== false;

  if (!webTokenConfigured) {
    findings.push(makeFinding(
      'web-token-missing',
      'warn',
      'WEB_TOKEN is missing',
      'Web console is running in localhost compatibility mode.',
      'Set WEB_TOKEN to a strong random value outside local-only development.'
    ));
  }

  if (!webTokenConfigured && !['127.0.0.1', 'localhost', '::1'].includes(webBindHost)) {
    findings.push(makeFinding(
      'web-token-missing-public-bind',
      'warn',
      'WEB_TOKEN missing with non-local bind host',
      `WEB_BIND_HOST is ${webBindHost}.`,
      'Set WEB_TOKEN before binding the console outside localhost.'
    ));
  }

  if (bridgeEnabled && !bridgeTokenConfigured) {
    findings.push(makeFinding(
      'local-command-bridge-token-missing',
      'warn',
      'LOCAL_COMMAND_BRIDGE_TOKEN is missing',
      'Local command bridge health checks remain available, but command execution is blocked.',
      'Generate a strong random token and set LOCAL_COMMAND_BRIDGE_TOKEN in .env before enabling command execution.'
    ));
  }

  if (findings.length === 0) {
    findings.push(makeFinding('token-posture-ok', 'ok', 'Tokens are configured', 'Web and command bridge tokens are present.'));
  }

  return {
    status: summarizeLevel(findings),
    webToken: webTokenConfigured ? 'configured' : 'missing',
    localCommandBridgeToken: bridgeTokenConfigured ? 'configured' : 'missing',
    webBindHost,
    localCommandBridgeEnabled: Boolean(bridgeEnabled),
    localCommandBridgeExecution: bridgeEnabled && bridgeTokenConfigured ? 'available' : 'blocked',
    findings
  };
}

function inspectNapCatReverseAuth(config = {}) {
  const enabled = config.NAPCAT_HTTP_REVERSE_ENABLED !== false;
  const secretConfigured = isConfigured(config.NAPCAT_HTTP_REVERSE_SECRET);
  const legacyBearerEnabled = config.NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER !== false;
  const findings = [];

  if (enabled && !secretConfigured) {
    findings.push(makeFinding(
      'napcat-reverse-secret-missing',
      'error',
      'NapCat HTTP reverse secret is missing',
      'The HTTP reverse ingress cannot start without NAPCAT_HTTP_REVERSE_SECRET.',
      'Set a strong random NAPCAT_HTTP_REVERSE_SECRET before enabling HTTP reverse ingress.'
    ));
  } else if (enabled && legacyBearerEnabled) {
    findings.push(makeFinding(
      'napcat-reverse-legacy-auth-enabled',
      'warn',
      'NapCat HTTP reverse compatibility authentication is enabled',
      'Static Bearer/X-NapCat-Token authentication remains enabled for native NapCat HTTP clients and does not provide replay protection.',
      'Keep the ingress bound to a trusted network, or disable NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER after all callers support signed requests.'
    ));
  } else {
    findings.push(makeFinding(
      'napcat-reverse-auth-strong',
      'ok',
      'NapCat HTTP reverse signed authentication is enforced',
      enabled ? 'Legacy static-token authentication is disabled.' : 'HTTP reverse ingress is disabled.'
    ));
  }

  return {
    status: summarizeLevel(findings),
    enabled,
    secret: secretConfigured ? 'configured' : 'missing',
    mode: legacyBearerEnabled ? 'signed-with-legacy-compatibility' : 'signed-only',
    findings
  };
}

function inspectApiBaseUrls(config = {}) {
  const items = [];
  const findings = [];

  for (const key of API_BASE_KEYS) {
    const value = normalizeText(config[key]);
    if (!value) {
      items.push({ key, status: 'missing' });
      continue;
    }
    const unsafe = isUnsafeHttpUrl(value);
    items.push({ key, status: unsafe ? 'warn' : 'ok', configured: true });
    if (unsafe) {
      findings.push(makeFinding(
        `unsafe-api-base-${key.toLowerCase()}`,
        'warn',
        `${key} points to a local/private URL`,
        `${key} is configured but not printed for secrecy.`,
        'Use a trusted external HTTPS endpoint unless local routing is intentional.'
      ));
    }
  }

  if (findings.length === 0) {
    findings.push(makeFinding('api-base-urls-ok', 'ok', 'API Base URLs look safe', 'Configured API endpoints are not local/private URLs.'));
  }

  return { status: summarizeLevel(findings), items, findings };
}

function listSourceFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  const ignored = new Set(['.git', 'node_modules', 'data', 'artifacts']);
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile() && /\.(js|ps1|cmd|sh|json|env|md)$/i.test(entry.name)) files.push(abs);
    }
  }
  return files;
}

function inspectSourceSecrets(rootDir = PROJECT_ROOT) {
  const leakedToken = LEAKED_TOKEN_PARTS.join('');
  const hits = [];
  for (const filePath of listSourceFiles(rootDir)) {
    let source = '';
    try { source = fs.readFileSync(filePath, 'utf8'); } catch (_) { continue; }
    if (source.includes(leakedToken)) {
      hits.push(path.relative(rootDir, filePath));
    }
  }
  if (hits.length > 0) {
    return {
      status: 'error',
      hits,
      findings: [makeFinding(
        'known-hardcoded-token-found',
        'error',
        'Known leaked token is still present in source',
        `${hits.length} source file(s) contain the known leaked token.`,
        'Remove the hard-coded token and rotate the real credential.'
      )]
    };
  }
  return {
    status: 'ok',
    hits: [],
    findings: [makeFinding('known-hardcoded-token-clean', 'ok', 'Known leaked token not found', 'Source scan found no full leaked token string.')]
  };
}

function collectSecurityDiagnostics(config = require('../config'), options = {}) {
  const tokenPosture = inspectTokenPosture(config);
  const napCatReverseAuth = inspectNapCatReverseAuth(config);
  const apiBaseUrls = inspectApiBaseUrls(config);
  const sourceSecrets = inspectSourceSecrets(options.rootDir || PROJECT_ROOT);
  const sections = { tokenPosture, napCatReverseAuth, apiBaseUrls, sourceSecrets };
  const findings = Object.values(sections).flatMap((section) => section.findings || []);
  return {
    status: summarizeLevel(findings),
    generatedAt: new Date().toISOString(),
    summary: {
      ok: findings.filter((finding) => finding.level === 'ok').length,
      warn: findings.filter((finding) => finding.level === 'warn').length,
      error: findings.filter((finding) => finding.level === 'error').length
    },
    sections,
    findings
  };
}

function formatSecurityWarning(finding) {
  const rec = finding.recommendation ? ` Recommendation: ${finding.recommendation}` : '';
  return `[security:${finding.id}] ${finding.title}. ${finding.detail}${rec}`;
}

function logStartupSecurityWarnings(config, logger = console.warn) {
  const diagnostics = collectSecurityDiagnostics(config, { rootDir: PROJECT_ROOT });
  for (const finding of diagnostics.findings) {
    if (finding.level !== 'warn' && finding.level !== 'error') continue;
    logger(formatSecurityWarning(finding));
  }
  return diagnostics;
}

module.exports = {
  collectSecurityDiagnostics,
  formatSecurityWarning,
  inspectApiBaseUrls,
  inspectNapCatReverseAuth,
  inspectSourceSecrets,
  inspectTokenPosture,
  logStartupSecurityWarnings,
  summarizeLevel
};

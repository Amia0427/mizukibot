// @ts-check
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

function isLoopbackHost(host = '') {
  return ['127.0.0.1', 'localhost', '::1'].includes(normalizeText(host).toLowerCase());
}

function inspectIngressExposure(config = {}, options = {}) {
  const findings = [];
  const webHost = normalizeText(config.WEB_BIND_HOST || '127.0.0.1') || '127.0.0.1';
  const napCatHost = normalizeText(config.NAPCAT_HTTP_REVERSE_BIND_HOST || '127.0.0.1') || '127.0.0.1';
  const napCatEnabled = config.NAPCAT_HTTP_REVERSE_ENABLED !== false;

  const webBoundary = options.webHostExposure || 'unknown';
  const napCatBoundary = options.napCatHostExposure || 'unknown';
  const webExternallyReachable = !isLoopbackHost(webHost) && webBoundary !== 'loopback';
  const napCatExternallyReachable = !isLoopbackHost(napCatHost) && napCatBoundary !== 'loopback';

  if (webExternallyReachable && !isConfigured(config.WEB_TOKEN)) {
    findings.push(makeFinding(
      'web-public-bind-without-auth',
      'error',
      'Web console is publicly bound without authentication',
      `WEB_BIND_HOST is ${webHost} and WEB_TOKEN is missing.`,
      'Bind the console to loopback or configure a strong WEB_TOKEN behind HTTPS.'
    ));
  } else if (webExternallyReachable) {
    findings.push(makeFinding(
      'web-public-bind',
      'warn',
      'Web console listens beyond loopback',
      `WEB_BIND_HOST is ${webHost}; token authentication alone does not provide transport encryption.`,
      'Restrict the bind address or place the console behind an authenticated HTTPS reverse proxy.'
    ));
  }

  if (napCatEnabled && napCatExternallyReachable && !isConfigured(config.NAPCAT_HTTP_REVERSE_SECRET)) {
    findings.push(makeFinding(
      'napcat-public-bind-without-auth',
      'error',
      'NapCat HTTP reverse ingress is publicly bound without authentication',
      `NAPCAT_HTTP_REVERSE_BIND_HOST is ${napCatHost} and the reverse secret is missing.`,
      'Bind the ingress to loopback or configure signed authentication before exposing it.'
    ));
  } else if (napCatEnabled && napCatExternallyReachable) {
    findings.push(makeFinding(
      'napcat-public-bind',
      config.NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER === false ? 'warn' : 'error',
      'NapCat HTTP reverse ingress listens beyond loopback',
      config.NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER === false
        ? `NAPCAT_HTTP_REVERSE_BIND_HOST is ${napCatHost} with signed-only authentication.`
        : `NAPCAT_HTTP_REVERSE_BIND_HOST is ${napCatHost} while replayable compatibility authentication is enabled.`,
      'Restrict the listener to a trusted network; require signed-only requests for non-loopback traffic.'
    ));
  }

  if (findings.length === 0) {
    findings.push(makeFinding('ingress-exposure-ok', 'ok', 'Ingress listeners are locally scoped', 'Web and enabled NapCat listeners bind to loopback.'));
  }
  return { status: summarizeLevel(findings), webBindHost: webHost, napCatBindHost: napCatHost, webHostExposure: webBoundary, napCatHostExposure: napCatBoundary, findings };
}

function inspectLogRetention(config = {}) {
  const maxFiles = Number(config.LOG_ROTATE_MAX_FILES ?? process.env.LOG_ROTATE_MAX_FILES ?? 10);
  const maxAgeMs = Number(config.LOG_ROTATE_MAX_AGE_MS ?? process.env.LOG_ROTATE_MAX_AGE_MS ?? 30 * 24 * 60 * 60 * 1000);
  const maxTotalBytes = Number(config.LOG_ROTATE_MAX_TOTAL_BYTES ?? process.env.LOG_ROTATE_MAX_TOTAL_BYTES ?? 1024 * 1024 * 1024);
  const diskWarnPercent = Number(config.LOG_DISK_WARN_PERCENT ?? process.env.LOG_DISK_WARN_PERCENT ?? 85);
  const diskErrorPercent = Number(config.LOG_DISK_ERROR_PERCENT ?? process.env.LOG_DISK_ERROR_PERCENT ?? 95);
  const findings = [];
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) {
    findings.push(makeFinding(
      'log-retention-unbounded',
      'warn',
      'Rotated log retention is unbounded',
      'LOG_ROTATE_MAX_FILES is missing, zero, or invalid, so rotated archives can grow without a file-count limit.',
      'Set LOG_ROTATE_MAX_FILES to a positive value and monitor the data volume.'
    ));
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    findings.push(makeFinding('log-retention-ttl-disabled', 'warn', 'Rotated log TTL is disabled', 'LOG_ROTATE_MAX_AGE_MS does not set a positive archive lifetime.'));
  }
  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes <= 0) {
    findings.push(makeFinding('log-retention-capacity-disabled', 'warn', 'Rotated log capacity limit is disabled', 'LOG_ROTATE_MAX_TOTAL_BYTES does not set a positive shared capacity for registered log archives.'));
  }
  if (!Number.isFinite(diskWarnPercent) || !Number.isFinite(diskErrorPercent)
    || diskWarnPercent <= 0 || diskErrorPercent <= diskWarnPercent || diskErrorPercent > 100) {
    findings.push(makeFinding('log-disk-watermarks-invalid', 'warn', 'Log disk watermarks are invalid', 'Log disk warning/error percentages must be ordered values within 1-100.'));
  }
  if (findings.length === 0) {
    findings.push(makeFinding(
      'log-retention-bounded',
      'ok',
      'Rotated log retention is bounded',
      `Each registered log family retains at most ${Math.floor(maxFiles)} archives for ${Math.floor(maxAgeMs)} ms, with ${Math.floor(maxTotalBytes)} shared archive bytes across the process.`
    ));
  }
  return {
    status: summarizeLevel(findings),
    maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? Math.floor(maxFiles) : 'unbounded',
    maxAgeMs: Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? Math.floor(maxAgeMs) : 'unbounded',
    maxTotalBytes: Number.isFinite(maxTotalBytes) && maxTotalBytes > 0 ? Math.floor(maxTotalBytes) : 'unbounded',
    diskWarnPercent,
    diskErrorPercent,
    findings
  };
}

function readWindowsAcl(targetPath) {
  if (process.platform !== 'win32') return { supported: false, reason: 'windows-only' };
  try {
    const escapedPath = targetPath.replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$acl = Get-Acl -LiteralPath '${escapedPath}'`,
      '$rules = foreach ($rule in $acl.Access) {',
      '  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value',
      '  [pscustomobject]@{ sid=$sid; type=$rule.AccessControlType.ToString(); rights=[int64]$rule.FileSystemRights; inherited=$rule.IsInherited; inheritanceFlags=$rule.InheritanceFlags.ToString(); propagationFlags=$rule.PropagationFlags.ToString() }',
      '}',
      '$rules | ConvertTo-Json -Compress'
    ].join('; ');
    let output = '';
    let lastError = null;
    for (const executable of ['pwsh.exe', 'powershell.exe']) {
      try {
        output = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    const parsed = output.trim() ? JSON.parse(output) : [];
    return { supported: true, rules: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (error) {
    return { supported: false, reason: error?.code || 'get-acl-failed' };
  }
}

const BROAD_WINDOWS_SIDS = new Set(['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545']);
const READ_RIGHTS_MASK = 1 | 8 | 32 | 128;
const WRITE_RIGHTS_MASK = 2 | 4 | 16 | 64 | 256 | 65536 | 262144 | 524288;

function effectiveBroadRights(rules = [], includeChildren = false) {
  const rightsBySidAndScope = new Map();
  for (const rule of rules) {
    const sid = normalizeText(rule?.sid).toUpperCase();
    if (!BROAD_WINDOWS_SIDS.has(sid)) continue;
    const inheritOnly = /InheritOnly/i.test(normalizeText(rule.propagationFlags));
    const inheritedToChildren = /ContainerInherit|ObjectInherit/i.test(normalizeText(rule.inheritanceFlags));
    const scopes = [];
    if (!inheritOnly) scopes.push('current');
    if (includeChildren && inheritedToChildren) scopes.push('children');
    for (const scope of scopes) {
      const key = `${sid}:${scope}`;
      const current = rightsBySidAndScope.get(key) || { allow: 0, deny: 0 };
      const rights = Number(rule.rights) || 0;
      if (normalizeText(rule.type).toLowerCase() === 'deny') current.deny |= rights;
      else current.allow |= rights;
      rightsBySidAndScope.set(key, current);
    }
  }
  let read = false;
  let write = false;
  for (const value of rightsBySidAndScope.values()) {
    const effective = value.allow & ~value.deny;
    read ||= Boolean(effective & READ_RIGHTS_MASK);
    write ||= Boolean(effective & WRITE_RIGHTS_MASK);
  }
  return { read, write };
}

function inspectSensitivePathAcls(rootDir = PROJECT_ROOT, aclReader = readWindowsAcl) {
  const findings = [];
  const paths = [
    { name: '.env', target: path.join(rootDir, '.env') },
    { name: 'data', target: path.join(rootDir, 'data') }
  ];
  for (const item of paths) {
    if (!fs.existsSync(item.target)) continue;
    const acl = aclReader(item.target);
    if (!acl?.supported) {
      findings.push(makeFinding(
        `acl-${item.name === '.env' ? 'dotenv' : item.name}-unchecked`,
        'warn',
        `${item.name} ACL could not be verified`,
        `The current platform or ACL reader could not inspect ${item.name}.`,
        'Verify that only the service account, SYSTEM, and Administrators can access this path.'
      ));
      continue;
    }
    const access = effectiveBroadRights(acl.rules, item.name === 'data');
    if (access.write) {
      findings.push(makeFinding(
        `acl-${item.name === '.env' ? 'dotenv' : item.name}-broad-write`,
        'error',
        `${item.name} is writable by a broad Windows principal`,
        `${item.name} grants effective write access to Everyone, Authenticated Users, or Users.`,
        'Remove inherited broad access and grant only the service account, SYSTEM, and Administrators.'
      ));
    } else if (access.read) {
      findings.push(makeFinding(
        `acl-${item.name === '.env' ? 'dotenv' : item.name}-broad-read`,
        'error',
        `${item.name} is readable by a broad Windows principal`,
        `${item.name} grants effective read access to Everyone, Authenticated Users, or Users.`,
        'Restrict sensitive path access to the service account, SYSTEM, and Administrators.'
      ));
    }
  }
  if (findings.length === 0) findings.push(makeFinding('sensitive-path-acl-ok', 'ok', 'Sensitive path ACLs are restricted', 'No broad Windows principal was found on existing sensitive paths.'));
  return { status: summarizeLevel(findings), findings };
}

function finalDockerUser(dockerfile = '') {
  let user = 'root';
  for (const rawLine of dockerfile.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (/^FROM\s+/i.test(line)) user = 'root';
    const match = line.match(/^USER\s+([^\s]+)/i);
    if (match) user = match[1];
  }
  return user;
}

function parseComposeServices(compose = '') {
  const lines = compose.split(/\r?\n/);
  const servicesIndex = lines.findIndex((line) => /^services:\s*(?:#.*)?$/.test(line));
  if (servicesIndex < 0) return null;
  const services = {};
  let current = null;
  let listKey = null;
  let currentPort = null;
  for (const line of lines.slice(servicesIndex + 1)) {
    if (/^\S/.test(line) && line.trim() && !line.trim().startsWith('#')) break;
    const serviceMatch = line.match(/^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (serviceMatch) {
      current = {
        name: serviceMatch[1],
        readOnly: false,
        init: false,
        capDropAll: false,
        noNewPrivileges: false,
        user: '',
        cpus: 0,
        memoryLimit: '',
        pidsLimit: 0,
        stopGracePeriod: '',
        writableTmpfs: false,
        ports: [],
        uncertainPorts: false
      };
      services[current.name] = current;
      listKey = null;
      currentPort = null;
      continue;
    }
    if (!current) continue;
    const property = line.match(/^    ([A-Za-z0-9_-]+):\s*(.*?)\s*(?:#.*)?$/);
    if (property) {
      listKey = property[1];
      currentPort = null;
      const value = property[2].replace(/["']/g, '');
      if (listKey === 'read_only') current.readOnly = value === 'true';
      if (listKey === 'init') current.init = value === 'true';
      if (listKey === 'cap_drop' && /\bALL\b/i.test(value)) current.capDropAll = true;
      if (listKey === 'user') current.user = value;
      if (listKey === 'cpus') current.cpus = Number(value) || 0;
      if (listKey === 'mem_limit') current.memoryLimit = value;
      if (listKey === 'pids_limit') current.pidsLimit = Number(value) || 0;
      if (listKey === 'stop_grace_period') current.stopGracePeriod = value;
      continue;
    }
    const listItem = line.match(/^      -\s*["']?(.*?)["']?\s*(?:#.*)?$/);
    if (listItem) {
      const value = listItem[1];
      if (listKey === 'cap_drop' && /^ALL$/i.test(value)) current.capDropAll = true;
      if (listKey === 'security_opt' && /^no-new-privileges\s*:\s*true$/i.test(value)) current.noNewPrivileges = true;
      if (listKey === 'tmpfs' && /^\/tmp(?::|$)/.test(value)) current.writableTmpfs = true;
      if (listKey === 'ports') {
        const target = value.match(/^target:\s*(.+)$/i);
        currentPort = target ? { target: target[1] } : null;
        current.ports.push(currentPort || value);
      }
      continue;
    }
    const portProperty = line.match(/^        (target|published|host_ip):\s*["']?(.*?)["']?\s*(?:#.*)?$/i);
    if (listKey === 'ports' && currentPort && portProperty) currentPort[portProperty[1].toLowerCase()] = portProperty[2];
  }
  return Object.values(services);
}

function isPublicPortMapping(mapping = '') {
  if (mapping && typeof mapping === 'object') {
    const portMapping = /** @type {Record<string, unknown>} */ (mapping);
    const values = [portMapping.target, portMapping.published, portMapping.host_ip].map(normalizeText);
    if (values.some((value) => /\$\{|\$[A-Za-z_]/.test(value))) return null;
    if (!portMapping.published) return null;
    return portMapping.host_ip ? !isLoopbackHost(String(portMapping.host_ip)) : true;
  }
  const value = normalizeText(mapping);
  if (!value) return null;
  const explicitHost = value.match(/^(\[[^\]]+\]|[^:]+):/);
  if (explicitHost && !/^\d+$/.test(explicitHost[1])) {
    const host = explicitHost[1].replace(/^\[|\]$/g, '');
    if (host === '0.0.0.0' || host === '::') return true;
    if (!/\$/.test(host)) return false;
  }
  if (/\$\{|\$[A-Za-z_]/.test(value)) return null;
  if (value.startsWith('target:')) return null;
  const parts = value.split(':');
  if (parts.length === 2) return true;
  if (parts.length >= 3) return !isLoopbackHost(parts.slice(0, -2).join(':').replace(/^\[|\]$/g, ''));
  return false;
}

function composePortExposure(compose = '', containerPort) {
  const services = parseComposeServices(compose);
  if (!services) return 'unknown';
  let found = false;
  let unknown = false;
  for (const service of services) {
    for (const mapping of service.ports) {
      const target = typeof mapping === 'object' ? mapping.target : mapping;
      if (!String(target).includes(String(containerPort))) continue;
      found = true;
      const publicBind = isPublicPortMapping(mapping);
      if (publicBind === null) unknown = true;
      else if (publicBind) return 'public';
    }
  }
  if (unknown || !found) return 'unknown';
  return 'loopback';
}

function inspectContainerBaseline(rootDir = PROJECT_ROOT, readText = (file) => fs.readFileSync(file, 'utf8')) {
  const findings = [];
  let dockerfile = '';
  let compose = '';
  try { dockerfile = readText(path.join(rootDir, 'Dockerfile')); } catch (_) {}
  try { compose = readText(path.join(rootDir, 'docker-compose.yml')); } catch (_) {}

  const runtimeUser = finalDockerUser(dockerfile);
  if (!runtimeUser || /^(?:root|0)(?::|$)/i.test(runtimeUser)) findings.push(makeFinding('docker-root-user', 'error', 'Final container stage runs as root', `The final Dockerfile stage has effective USER ${runtimeUser || 'root'}.`, 'Run the production image as a dedicated unprivileged user.'));
  const services = parseComposeServices(compose);
  if (!services || services.length === 0) {
    findings.push(makeFinding('compose-baseline-unparsed', 'warn', 'Compose security baseline could not be parsed', 'No conventional services block was found.', 'Verify each service security baseline manually.'));
  } else {
    for (const service of services) {
      if (!service.readOnly) findings.push(makeFinding(`compose-${service.name}-rootfs-writable`, 'warn', `${service.name} root filesystem is writable`, 'read_only: true is not configured for this service.', 'Use a read-only root filesystem and explicit writable volumes or tmpfs mounts.'));
      if (!service.init) findings.push(makeFinding(`compose-${service.name}-init-missing`, 'warn', `${service.name} has no init process`, 'init: true is not configured for this service.', 'Enable the minimal init process so orphaned child processes are reaped.'));
      if (!service.capDropAll) findings.push(makeFinding(`compose-${service.name}-capabilities-not-dropped`, 'warn', `${service.name} does not drop all capabilities`, 'cap_drop: ALL is not configured for this service.', 'Drop all capabilities and add back only those proven necessary.'));
      if (!service.noNewPrivileges) findings.push(makeFinding(`compose-${service.name}-new-privileges-allowed`, 'warn', `${service.name} does not enforce no-new-privileges`, 'security_opt lacks no-new-privileges:true for this service.', 'Set no-new-privileges:true for this service.'));
      if (service.cpus <= 0) findings.push(makeFinding(`compose-${service.name}-cpu-limit-missing`, 'warn', `${service.name} has no CPU limit`, 'cpus is missing or invalid for this service.', 'Set a tested CPU limit to contain runaway work.'));
      if (!service.memoryLimit) findings.push(makeFinding(`compose-${service.name}-memory-limit-missing`, 'warn', `${service.name} has no memory limit`, 'mem_limit is not configured for this service.', 'Set a tested memory limit above the observed steady-state requirement.'));
      if (service.pidsLimit <= 0) findings.push(makeFinding(`compose-${service.name}-pids-limit-missing`, 'warn', `${service.name} has no process limit`, 'pids_limit is missing or invalid for this service.', 'Set a process limit that permits normal child processes without allowing unbounded forks.'));
      if (!service.stopGracePeriod) findings.push(makeFinding(`compose-${service.name}-stop-grace-period-missing`, 'warn', `${service.name} has no explicit stop grace period`, 'stop_grace_period is not configured for this service.', 'Set a grace period long enough for normal shutdown cleanup.'));
      if (!service.writableTmpfs) findings.push(makeFinding(`compose-${service.name}-tmpfs-missing`, 'warn', `${service.name} has no writable temporary filesystem`, 'No /tmp tmpfs mount was found for the read-only service.', 'Mount a size-limited /tmp tmpfs with nosuid, nodev, and noexec where compatible.'));
      if (/^(?:root|0)(?::|$)/i.test(service.user)) findings.push(makeFinding(`compose-${service.name}-root-user`, 'error', `${service.name} overrides the image user with root`, `The service user is ${service.user}.`, 'Remove the root user override or use a dedicated numeric UID/GID.'));
      const portStates = service.ports.map(isPublicPortMapping);
      const publicPorts = portStates.filter((state) => state === true);
      if (publicPorts.length > 0) findings.push(makeFinding(`compose-${service.name}-public-port-bind`, 'error', `${service.name} publishes ports on all interfaces`, `${publicPorts.length} host port mapping(s) omit a loopback or specific host address.`, 'Bind management and ingress ports to 127.0.0.1 or a specifically controlled interface.'));
      if (portStates.some((state) => state === null)) findings.push(makeFinding(`compose-${service.name}-port-bind-unresolved`, 'warn', `${service.name} port binding could not be resolved`, 'A variable or long-syntax port mapping prevents reliable host exposure analysis.', 'Resolve the effective Compose configuration and verify host_ip is loopback or a controlled address.'));
    }
  }
  if (findings.length === 0) findings.push(makeFinding('container-baseline-ok', 'ok', 'Container security baseline is present', 'Non-root, read-only, capability, privilege, resource-limit, temporary-filesystem, shutdown, and port-binding checks passed.'));
  return { status: summarizeLevel(findings), findings };
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
  const deploymentContext = normalizeText(options.deploymentContext || process.env.MIZUKIBOT_DEPLOYMENT_CONTEXT).toLowerCase();
  let composeText = '';
  if (deploymentContext === 'compose') {
    try { composeText = (options.readText || ((file) => fs.readFileSync(file, 'utf8')))(path.join(options.rootDir || PROJECT_ROOT, 'docker-compose.yml')); } catch (_) {}
  }
  const ingressExposure = inspectIngressExposure(config, {
    webHostExposure: deploymentContext === 'compose' ? composePortExposure(composeText, config.WEB_PORT || 3005) : 'direct',
    napCatHostExposure: deploymentContext === 'compose' ? composePortExposure(composeText, config.NAPCAT_HTTP_REVERSE_PORT || 3002) : 'direct'
  });
  const logRetention = inspectLogRetention(config);
  const sensitivePathAcls = inspectSensitivePathAcls(options.rootDir || PROJECT_ROOT, options.aclReader || readWindowsAcl);
  const containerBaseline = inspectContainerBaseline(options.rootDir || PROJECT_ROOT, options.readText);
  const sections = { tokenPosture, napCatReverseAuth, ingressExposure, apiBaseUrls, logRetention, sensitivePathAcls, containerBaseline, sourceSecrets };
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
  inspectContainerBaseline,
  inspectIngressExposure,
  inspectLogRetention,
  inspectNapCatReverseAuth,
  inspectSensitivePathAcls,
  inspectSourceSecrets,
  inspectTokenPosture,
  logStartupSecurityWarnings,
  summarizeLevel
};

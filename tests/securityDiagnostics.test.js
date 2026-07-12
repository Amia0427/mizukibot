const assert = require('assert');

const {
  collectSecurityDiagnostics,
  formatSecurityWarning,
  inspectApiBaseUrls,
  inspectContainerBaseline,
  inspectIngressExposure,
  inspectLogRetention,
  inspectNapCatReverseAuth,
  inspectSensitivePathAcls,
  inspectSourceSecrets,
  inspectTokenPosture
} = require('../utils/securityDiagnostics');

const baseConfig = {
  WEB_BIND_HOST: '127.0.0.1',
  WEB_TOKEN: '',
  LOCAL_COMMAND_BRIDGE_ENABLED: true,
  LOCAL_COMMAND_BRIDGE_TOKEN: '',
  NAPCAT_HTTP_REVERSE_SECRET: 'reverse-secret',
  NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER: true,
  API_BASE_URL: 'https://api.example.com/v1'
};

const missingTokens = inspectTokenPosture(baseConfig);
assert.strictEqual(missingTokens.status, 'warn');
assert.strictEqual(missingTokens.webToken, 'missing');
assert.strictEqual(missingTokens.localCommandBridgeToken, 'missing');
assert.strictEqual(missingTokens.localCommandBridgeExecution, 'blocked');

const configuredTokens = inspectTokenPosture({
  ...baseConfig,
  WEB_TOKEN: 'web-token',
  LOCAL_COMMAND_BRIDGE_TOKEN: 'bridge-token'
});
assert.strictEqual(configuredTokens.status, 'ok');
assert.strictEqual(configuredTokens.localCommandBridgeExecution, 'available');

const publicBind = inspectTokenPosture({ ...baseConfig, WEB_BIND_HOST: '0.0.0.0' });
assert.ok(publicBind.findings.some((finding) => finding.id === 'web-token-missing-public-bind'));

const exposedIngress = inspectIngressExposure({
  WEB_BIND_HOST: '0.0.0.0',
  WEB_TOKEN: '',
  NAPCAT_HTTP_REVERSE_ENABLED: true,
  NAPCAT_HTTP_REVERSE_BIND_HOST: '0.0.0.0',
  NAPCAT_HTTP_REVERSE_SECRET: 'secret',
  NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER: true
});
assert.strictEqual(exposedIngress.status, 'error');
assert.ok(exposedIngress.findings.some((finding) => finding.id === 'web-public-bind-without-auth'));
assert.ok(exposedIngress.findings.some((finding) => finding.id === 'napcat-public-bind'));

const containerLoopbackBoundary = inspectIngressExposure({
  WEB_BIND_HOST: '0.0.0.0',
  WEB_TOKEN: '',
  NAPCAT_HTTP_REVERSE_ENABLED: true,
  NAPCAT_HTTP_REVERSE_BIND_HOST: '0.0.0.0',
  NAPCAT_HTTP_REVERSE_SECRET: 'secret',
  NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER: true
}, { webHostExposure: 'loopback', napCatHostExposure: 'loopback' });
assert.strictEqual(containerLoopbackBoundary.status, 'ok');

assert.strictEqual(inspectLogRetention({ LOG_ROTATE_MAX_FILES: 0 }).status, 'warn');
assert.strictEqual(inspectLogRetention({ LOG_ROTATE_MAX_FILES: 7 }).status, 'ok');
assert.strictEqual(inspectLogRetention({ LOG_ROTATE_MAX_FILES: 7, LOG_ROTATE_MAX_AGE_MS: 0 }).status, 'warn');
assert.strictEqual(inspectLogRetention({ LOG_ROTATE_MAX_FILES: 7, LOG_ROTATE_MAX_TOTAL_BYTES: 0 }).status, 'warn');
assert.strictEqual(inspectLogRetention({ LOG_ROTATE_MAX_FILES: 7, LOG_DISK_WARN_PERCENT: 95, LOG_DISK_ERROR_PERCENT: 85 }).status, 'warn');

const broadAcl = inspectSensitivePathAcls(require('path').resolve(__dirname, '..'), () => ({
  supported: true,
  rules: [{ sid: 'S-1-5-32-545', type: 'Allow', rights: 2032127, inherited: true, inheritanceFlags: 'ContainerInherit, ObjectInherit', propagationFlags: 'None' }]
}));
assert.strictEqual(broadAcl.status, 'error');

const deniedAcl = inspectSensitivePathAcls(require('path').resolve(__dirname, '..'), () => ({
  supported: true,
  rules: [
    { sid: 'S-1-1-0', type: 'Allow', rights: 131209, propagationFlags: 'None' },
    { sid: 'S-1-1-0', type: 'Deny', rights: 131209, propagationFlags: 'None' }
  ]
}));
assert.strictEqual(deniedAcl.status, 'ok');

const readOnlyAcl = inspectSensitivePathAcls(require('path').resolve(__dirname, '..'), (target) => ({
  supported: true,
  rules: [{ sid: 'S-1-5-11', type: 'Allow', rights: 131209, propagationFlags: 'None' }]
}));
assert.strictEqual(readOnlyAcl.status, 'error');
assert.ok(readOnlyAcl.findings.some((finding) => finding.id === 'acl-dotenv-broad-read' && finding.level === 'error'));
assert.ok(readOnlyAcl.findings.some((finding) => finding.id === 'acl-data-broad-read' && finding.level === 'error'));

const unreadableAcl = inspectSensitivePathAcls(require('path').resolve(__dirname, '..'), () => ({ supported: false }));
assert.strictEqual(unreadableAcl.status, 'warn');
assert.ok(!unreadableAcl.findings.some((finding) => finding.level === 'ok'));

const inheritOnlyAcl = inspectSensitivePathAcls(require('path').resolve(__dirname, '..'), () => ({
  supported: true,
  rules: [{ sid: 'S-1-1-0', type: 'Allow', rights: 2032127, inheritanceFlags: 'ContainerInherit, ObjectInherit', propagationFlags: 'InheritOnly' }]
}));
assert.strictEqual(inheritOnlyAcl.status, 'error');
assert.ok(inheritOnlyAcl.findings.some((finding) => finding.id === 'acl-data-broad-write'));

const crossSidDeny = inspectSensitivePathAcls(require('path').resolve(__dirname, '..'), () => ({
  supported: true,
  rules: [
    { sid: 'S-1-1-0', type: 'Allow', rights: 131209, propagationFlags: 'None' },
    { sid: 'S-1-5-11', type: 'Deny', rights: 131209, propagationFlags: 'None' }
  ]
}));
assert.strictEqual(crossSidDeny.status, 'error');

const insecureContainer = inspectContainerBaseline(__dirname, (file) => (
  file.endsWith('Dockerfile') ? 'FROM node:20\nCMD ["node","index.js"]' : 'services:\n  app:\n    ports:\n      - "3005:3005"\n'
));
assert.strictEqual(insecureContainer.status, 'error');
assert.ok(insecureContainer.findings.some((finding) => finding.id === 'docker-root-user'));
assert.ok(insecureContainer.findings.some((finding) => finding.id === 'compose-app-public-port-bind'));

const finalStageRoot = inspectContainerBaseline(__dirname, (file) => (
  file.endsWith('Dockerfile')
    ? 'FROM node:20 AS build\nUSER node\nFROM node:20 AS runtime\nCMD ["node","index.js"]\n'
    : 'services:\n  app:\n    read_only: true\n    cap_drop: [ALL]\n    security_opt:\n      - no-new-privileges:true\n'
));
assert.ok(finalStageRoot.findings.some((finding) => finding.id === 'docker-root-user'));

const unparsedCompose = inspectContainerBaseline(__dirname, (file) => (
  file.endsWith('Dockerfile') ? 'FROM node:20\nUSER node\n' : 'name: invalid-without-services\n'
));
assert.strictEqual(unparsedCompose.status, 'warn');
assert.ok(unparsedCompose.findings.some((finding) => finding.id === 'compose-baseline-unparsed'));

const longSyntaxCompose = inspectContainerBaseline(__dirname, (file) => (
  file.endsWith('Dockerfile')
    ? 'FROM node:20\nUSER node\n'
    : 'services:\n  app:\n    user: root\n    read_only: true\n    cap_drop: [ALL]\n    security_opt:\n      - no-new-privileges:true\n    ports:\n      - target: 3005\n        published: "3005"\n        host_ip: "127.0.0.1"\n'
));
assert.ok(longSyntaxCompose.findings.some((finding) => finding.id === 'compose-app-root-user'));
assert.ok(!longSyntaxCompose.findings.some((finding) => finding.id === 'compose-app-public-port-bind'));
assert.ok(!longSyntaxCompose.findings.some((finding) => finding.id === 'compose-app-port-bind-unresolved'));

const variablePort = inspectContainerBaseline(__dirname, (file) => (
  file.endsWith('Dockerfile')
    ? 'FROM node:20\nUSER node\n'
    : 'services:\n  app:\n    read_only: true\n    cap_drop: [ALL]\n    security_opt:\n      - no-new-privileges:true\n    ports:\n      - "${WEB_HOST_IP}:${WEB_PORT}:3005"\n'
));
assert.ok(variablePort.findings.some((finding) => finding.id === 'compose-app-port-bind-unresolved'));

const secureContainer = inspectContainerBaseline(__dirname, (file) => (
  file.endsWith('Dockerfile')
    ? 'FROM node:20\nUSER node\n'
    : 'services:\n  app:\n    user: node\n    read_only: true\n    init: true\n    cpus: "1.0"\n    mem_limit: 1g\n    pids_limit: 128\n    stop_grace_period: 30s\n    cap_drop: [ALL]\n    security_opt:\n      - no-new-privileges:true\n    tmpfs:\n      - /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777\n    ports:\n      - "127.0.0.1:3005:3005"\n'
));
assert.strictEqual(secureContainer.status, 'ok');

const repositoryContainer = inspectContainerBaseline(require('path').resolve(__dirname, '..'));
assert.ok(!repositoryContainer.findings.some((finding) => finding.id === 'docker-root-user'));
assert.ok(!repositoryContainer.findings.some((finding) => finding.id.endsWith('-public-port-bind')));
assert.strictEqual(repositoryContainer.status, 'ok');

const compatibleNapCatAuth = inspectNapCatReverseAuth({
  NAPCAT_HTTP_REVERSE_ENABLED: true,
  NAPCAT_HTTP_REVERSE_SECRET: 'reverse-secret',
  NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER: true
});
assert.strictEqual(compatibleNapCatAuth.status, 'warn');
assert.strictEqual(compatibleNapCatAuth.mode, 'signed-with-legacy-compatibility');
assert.ok(compatibleNapCatAuth.findings.some((finding) => finding.id === 'napcat-reverse-legacy-auth-enabled'));

const signedOnlyNapCatAuth = inspectNapCatReverseAuth({
  NAPCAT_HTTP_REVERSE_ENABLED: true,
  NAPCAT_HTTP_REVERSE_SECRET: 'reverse-secret',
  NAPCAT_HTTP_REVERSE_ALLOW_LEGACY_BEARER: false
});
assert.strictEqual(signedOnlyNapCatAuth.status, 'ok');
assert.strictEqual(signedOnlyNapCatAuth.mode, 'signed-only');

const apiUrls = inspectApiBaseUrls({
  API_BASE_URL: 'https://api.example.com/v1',
  MEMORY_API_BASE_URL: 'http://127.0.0.1:9999',
  IMAGE_API_BASE_URL: 'http://192.168.1.10'
});
assert.strictEqual(apiUrls.status, 'warn');
assert.ok(apiUrls.findings.some((finding) => finding.id.includes('memory_api_base_url')));

const sourceSecrets = inspectSourceSecrets();
assert.strictEqual(sourceSecrets.status, 'ok');

const secureOptions = {
  aclReader: () => ({ supported: true, rules: [
    { sid: 'S-1-5-18', type: 'Allow', rights: 2032127, propagationFlags: 'None' },
    { sid: 'S-1-5-32-544', type: 'Allow', rights: 2032127, propagationFlags: 'None' }
  ] }),
  readText: (file) => (
    file.endsWith('Dockerfile')
      ? 'FROM node:20\nUSER node\n'
      : 'services:\n  app:\n    read_only: true\n    cap_drop: [ALL]\n    security_opt:\n      - no-new-privileges:true\n    ports:\n      - "127.0.0.1:3005:3005"\n      - "127.0.0.1:3002:3002"\n'
  )
};
const directProcessReport = collectSecurityDiagnostics({
  ...baseConfig,
  WEB_BIND_HOST: '0.0.0.0',
  WEB_TOKEN: '',
  NAPCAT_HTTP_REVERSE_BIND_HOST: '127.0.0.1',
  LOG_ROTATE_MAX_FILES: 5
}, { ...secureOptions, deploymentContext: 'direct' });
assert.ok(directProcessReport.findings.some((finding) => finding.id === 'web-public-bind-without-auth'));

const composeLoopbackReport = collectSecurityDiagnostics({
  ...baseConfig,
  WEB_BIND_HOST: '0.0.0.0',
  WEB_TOKEN: '',
  NAPCAT_HTTP_REVERSE_BIND_HOST: '0.0.0.0',
  LOG_ROTATE_MAX_FILES: 5
}, { ...secureOptions, deploymentContext: 'compose' });
assert.ok(!composeLoopbackReport.findings.some((finding) => finding.id === 'web-public-bind-without-auth'));
assert.strictEqual(composeLoopbackReport.sections.ingressExposure.status, 'ok');

const report = collectSecurityDiagnostics(baseConfig, secureOptions);
assert.strictEqual(report.status, 'warn');
assert.ok(report.summary.warn >= 1);
const secretReport = collectSecurityDiagnostics({
  ...baseConfig,
  WEB_TOKEN: 'super-secret-web-token',
  LOCAL_COMMAND_BRIDGE_TOKEN: 'super-secret-bridge-token',
  API_KEY: 'super-secret-api-key'
}, secureOptions);
const secretJson = JSON.stringify(secretReport);
assert.ok(!secretJson.includes('super-secret-web-token'));
assert.ok(!secretJson.includes('super-secret-bridge-token'));
assert.ok(!secretJson.includes('super-secret-api-key'));

const warning = formatSecurityWarning(missingTokens.findings.find((finding) => finding.level === 'warn'));
assert.ok(warning.includes('Recommendation:'));

console.log('securityDiagnostics.test.js passed');

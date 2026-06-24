#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const allowedExactPaths = new Set([
  '.dockerignore',
  '.env.example',
  '.env.skills.example',
  'Dockerfile',
  'README.md',
  'deploy/README.md',
  'deploy/beginner-guide.md',
  'deploy/docker/README.md',
  'deploy/linux/LINUX_DEPLOY_FULL.md',
  'deploy/linux/README_LINUX.md',
  'deploy/private-prompts.md',
  'docker-compose.yml',
  'docs/npm-publish.md',
  'index.js',
  'package.json',
  'prompts/GEMINI.txt',
  'prompts/SYSTEM.txt',
  'prompts/defaut.txt',
  'prompts/prompt-manifest.json',
  'restart-bot.cmd'
]);

const allowedPrefixes = [
  'api/',
  'config/',
  'core/',
  'prompts/persona_modules/',
  'prompts/persona_worldbook/',
  'prompts/runtime/',
  'scripts/',
  'src/',
  'utils/',
  'web/'
];

const requiredFilesEntries = [
  'api/',
  'config/',
  'core/',
  'docs/npm-publish.md',
  'index.js',
  'prompts/prompt-manifest.json',
  'scripts/',
  'src/',
  'utils/',
  'web/'
];

const forbiddenFilesEntries = [
  '.',
  './',
  '*',
  '.*',
  '.env',
  '.mcp.json',
  '.npmrc',
  '.husky/',
  '.claude/',
  '.playwright-mcp/',
  'artifacts/',
  'data/',
  'docs/',
  'logs/',
  'node_modules/',
  'prompts/',
  'prompts/admin.txt',
  'prompts/persona/',
  'secrets/',
  'skills/',
  'tests/',
  'tmp/'
];

const safeEnvExamplePaths = new Set(['.env.example', '.env.skills.example']);

const forbiddenPathRules = [
  { name: 'local env file', regex: /(^|\/)\.env(?:\..*)?$/i, allow: safeEnvExamplePaths },
  { name: 'npm credential file', regex: /(^|\/)\.npmrc$/i },
  { name: 'MCP local config', regex: /(^|\/)\.mcp\.json$/i },
  { name: 'local agent directory', regex: /(^|\/)(?:\.claude|\.playwright-mcp|\.husky|\.git|\.github)\//i },
  { name: 'runtime data directory', regex: /(^|\/)(?:data|logs|artifacts|tmp)\//i },
  { name: 'local skills directory', regex: /(^|\/)skills\//i },
  { name: 'test directory', regex: /(^|\/)tests\//i },
  { name: 'secrets directory', regex: /(^|\/)secrets\//i },
  { name: 'private prompt', regex: /^prompts\/(?:admin\.txt|persona\/)/i },
  { name: 'private key file', regex: /\.(?:key|pem|p12|pfx)$/i },
  { name: 'prompt backup archive', regex: /^prompts\/.*\.(?:bak|zip)$/i }
];

const contentRules = [
  { name: 'private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'OpenAI-style API key', regex: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/ },
  { name: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: 'JWT token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ }
];

const envAssignmentRule = {
  name: 'sensitive env assignment',
  regex: /^\s*[A-Z0-9_]*(?:API|TOKEN|SECRET|KEY|PASSWORD|PASSWD|AUTH)[A-Z0-9_]*\s*=\s*(?!["']?(?:changeme|change_me|example|placeholder|your_|xxx|test|dummy|none|null|false|true|0)?["']?\s*(?:#.*)?$)["']?[^#\r\n]{12,}/gmi
};

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function readPackageJson() {
  const filePath = path.join(ROOT, 'package.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function findLine(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function isAllowedPackagePath(file) {
  return allowedExactPaths.has(file) || allowedPrefixes.some((prefix) => file.startsWith(prefix));
}

function isEnvLikePath(file) {
  return /(^|\/)\.env(?:\..*)?$/i.test(file)
    || /(^|\/)secrets\//i.test(file)
    || /\.(?:env|conf|config|ini|properties|ya?ml|json)$/i.test(file);
}

function assertPackageConfig(pkg) {
  const failures = [];
  if (pkg.private === true) {
    failures.push('package.json must not set private=true before npm publish.');
  }
  if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') {
    failures.push('package.json must keep publishConfig.access="public".');
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    failures.push('package.json must use a non-empty files whitelist.');
  }
  const normalizedFiles = new Set((pkg.files || []).map(normalizePath));
  for (const entry of requiredFilesEntries) {
    if (!normalizedFiles.has(entry)) {
      failures.push(`package.json files whitelist is missing ${entry}.`);
    }
  }
  for (const entry of forbiddenFilesEntries) {
    if (normalizedFiles.has(entry)) {
      failures.push(`package.json files whitelist must not include ${entry}.`);
    }
  }
  if (!pkg.scripts || pkg.scripts.prepublishOnly !== 'npm run publish:check') {
    failures.push('package.json must keep prepublishOnly="npm run publish:check".');
  }
  if (!pkg.scripts || pkg.scripts['publish:check'] !== 'node scripts/verify-npm-publish.js') {
    failures.push('package.json must keep publish:check="node scripts/verify-npm-publish.js".');
  }
  return failures;
}

function readPackManifest() {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : 'npm';
  const args = npmExecPath
    ? [npmExecPath, 'pack', '--dry-run', '--json', '--ignore-scripts']
    : ['pack', '--dry-run', '--json', '--ignore-scripts'];
  const output = execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const manifest = JSON.parse(output);
  if (!Array.isArray(manifest) || manifest.length !== 1) {
    throw new Error('npm pack returned an unexpected manifest shape.');
  }
  return manifest[0];
}

function scanPackagePaths(files) {
  const findings = [];
  for (const file of files) {
    if (!isAllowedPackagePath(file)) {
      findings.push(`${file}: outside the approved publish whitelist`);
    }
    for (const rule of forbiddenPathRules) {
      if (rule.allow && rule.allow.has(file)) continue;
      if (rule.regex.test(file)) {
        findings.push(`${file}: ${rule.name}`);
      }
    }
  }
  return findings;
}

function scanFileContent(file) {
  const filePath = path.join(ROOT, file);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) {
    return [];
  }
  const text = buffer.toString('utf8');
  const findings = [];
  for (const rule of contentRules) {
    rule.regex.lastIndex = 0;
    const match = rule.regex.exec(text);
    if (match) {
      findings.push(`${file}:${findLine(text, match.index)} ${rule.name}`);
    }
  }
  if (isEnvLikePath(file) && !safeEnvExamplePaths.has(file)) {
    envAssignmentRule.regex.lastIndex = 0;
    const match = envAssignmentRule.regex.exec(text);
    if (match) {
      findings.push(`${file}:${findLine(text, match.index)} ${envAssignmentRule.name}`);
    }
  }
  return findings;
}

function scanPackageContent(files) {
  return files.flatMap(scanFileContent);
}

function fail(failures) {
  console.error('[npm-publish] publish check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

function main() {
  const configFailures = assertPackageConfig(readPackageJson());
  const manifest = readPackManifest();
  const files = manifest.files.map((item) => normalizePath(item.path));
  const failures = [
    ...configFailures,
    ...scanPackagePaths(files),
    ...scanPackageContent(files)
  ];
  if (failures.length > 0) {
    fail(failures);
  }
  console.log(`[npm-publish] publish check passed: ${manifest.entryCount} files, ${manifest.unpackedSize} unpacked bytes`);
}

main();

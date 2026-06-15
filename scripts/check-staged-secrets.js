#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');

const MAX_SCAN_BYTES = 1024 * 1024;
const SAFE_EXAMPLE_FILES = new Set(['.env.example', '.env.skills.example']);

const secretPathRules = [
  { name: 'local env file', regex: /(^|[\\/])\.env(?:\..*)?$/i },
  { name: 'secrets directory', regex: /(^|[\\/])secrets[\\/]/i },
  { name: 'private key file', regex: /\.(?:key|pem|p12|pfx)$/i },
];

const contentRules = [
  { name: 'private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'OpenAI-style API key', regex: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/ },
  { name: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: 'JWT token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

const envAssignmentRule = {
  name: 'sensitive env assignment',
  regex: /^\s*[A-Z0-9_]*(?:API|TOKEN|SECRET|KEY|PASSWORD|PASSWD|AUTH)[A-Z0-9_]*\s*=\s*(?!["']?(?:changeme|change_me|example|placeholder|your_|xxx|test|dummy|none|null|false|true|0)?["']?\s*(?:#.*)?$)["']?[^#\r\n]{12,}/gmi,
};

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: options.encoding || 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function getStagedFiles() {
  const output = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  return output.split('\0').filter(Boolean);
}

function isSafeExamplePath(file) {
  return SAFE_EXAMPLE_FILES.has(file.replace(/\\/g, '/'));
}

function shouldScanEnvAssignments(file) {
  const normalized = file.replace(/\\/g, '/');
  return /(^|\/)\.env(?:\..*)?$/i.test(normalized)
    || /(^|\/)secrets\//i.test(normalized)
    || /\.(?:env|conf|config|ini|properties|ya?ml|json)$/i.test(normalized);
}

function getStagedContent(file) {
  try {
    return execFileSync('git', ['show', `:${file}`], {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_SCAN_BYTES + 1,
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`failed to read staged content for ${file}: ${stderr}`);
  }
}

function findLine(text, index) {
  const before = text.slice(0, index);
  return before.split(/\r?\n/).length;
}

function scanFile(file) {
  const findings = [];

  if (!isSafeExamplePath(file)) {
    for (const rule of secretPathRules) {
      if (rule.regex.test(file)) {
        findings.push({ file, rule: rule.name, line: 1 });
      }
    }
  }

  const buffer = getStagedContent(file);
  if (buffer.includes(0)) {
    return findings;
  }

  const truncated = buffer.length > MAX_SCAN_BYTES;
  const text = buffer.subarray(0, MAX_SCAN_BYTES).toString('utf8');

  for (const rule of contentRules) {
    rule.regex.lastIndex = 0;
    const match = rule.regex.exec(text);
    if (match) {
      findings.push({ file, rule: rule.name, line: findLine(text, match.index) });
    }
  }

  if (shouldScanEnvAssignments(file)) {
    envAssignmentRule.regex.lastIndex = 0;
    const match = envAssignmentRule.regex.exec(text);
    if (match) {
      findings.push({ file, rule: envAssignmentRule.name, line: findLine(text, match.index) });
    }
  }

  if (truncated) {
    findings.push({ file, rule: 'file exceeds staged secret scan size limit', line: 1 });
  }

  return findings;
}

function main() {
  const stagedFiles = getStagedFiles();
  const findings = stagedFiles.flatMap(scanFile);

  if (findings.length === 0) {
    console.log('[secrets] staged secret scan passed');
    return;
  }

  console.error('[secrets] staged secret scan blocked this commit:');
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} ${finding.rule}`);
  }
  console.error('Remove the secret from staged content, or move local credentials into untracked .env files.');
  process.exit(1);
}

main();

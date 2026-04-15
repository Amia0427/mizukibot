const fs = require('fs');
const path = require('path');

const DEFAULT_ENV_PATH = path.join(path.resolve(__dirname, '..'), '.env');

function sanitizeEnvKey(key) {
  const text = String(key || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    throw new Error(`Invalid env key: ${key}`);
  }
  return text;
}

function sanitizeEnvValue(value) {
  // Flatten CR/LF/NUL to stop line-break based env injection.
  return String(value ?? '')
    .replace(/[\r\n\0]+/g, ' ')
    .trim();
}

function readEnvRaw(envPath = DEFAULT_ENV_PATH) {
  try {
    if (!fs.existsSync(envPath)) return '';
    return fs.readFileSync(envPath, 'utf8');
  } catch (_) {
    return '';
  }
}

function upsertEnv(raw, key, value) {
  const safeKey = sanitizeEnvKey(key);
  const safeValue = sanitizeEnvValue(value);
  const lines = String(raw || '').split(/\r?\n/);
  const output = [];
  let replaced = false;

  for (const line of lines) {
    if (/^\s*#/.test(line) || !line.includes('=')) {
      output.push(line);
      continue;
    }

    const idx = line.indexOf('=');
    const currentKey = line.slice(0, idx).trim();

    if (currentKey === safeKey) {
      output.push(`${safeKey}=${safeValue}`);
      replaced = true;
    } else {
      output.push(line);
    }
  }

  if (!replaced) output.push(`${safeKey}=${safeValue}`);
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function setEnvPairs(pairs, envPath = DEFAULT_ENV_PATH) {
  let raw = readEnvRaw(envPath);

  for (const [key, value] of Object.entries(pairs || {})) {
    if (!key) continue;
    if (value === undefined || value === null) continue;
    raw = upsertEnv(raw, key, value);
  }

  fs.writeFileSync(envPath, raw, 'utf8');
  return raw;
}

function maskSecret(value, prefix = 3, suffix = 3) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= prefix + suffix) return `${text.slice(0, 1)}***`;
  return `${text.slice(0, prefix)}***${text.slice(-suffix)}`;
}

module.exports = {
  DEFAULT_ENV_PATH,
  readEnvRaw,
  sanitizeEnvKey,
  sanitizeEnvValue,
  upsertEnv,
  setEnvPairs,
  maskSecret
};

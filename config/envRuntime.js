const fs = require('fs');
const path = require('path');

const REQUIRED_ENV_KEYS = ['API_KEY'];

function loadLocalEnvFallback(rootDir = path.resolve(__dirname, '..')) {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof process.env[key] === 'string' && process.env[key] !== '') continue;

    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function loadEnvironment(rootDir = path.resolve(__dirname, '..')) {
  // Prefer dotenv when available, but keep startup independent from that optional dependency.
  try {
    require('dotenv').config();
  } catch (_) {
    loadLocalEnvFallback(rootDir);
  }
}

function pick(key, fallback) {
  const value = process.env[key];
  return (typeof value === 'string' && value.trim() !== '') ? value.trim() : fallback;
}

function pickNum(key, fallback) {
  const value = process.env[key];
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickBool(key, fallback = false) {
  const value = String(process.env[key] || '').toLowerCase().trim();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function pickIntList(key, fallback = []) {
  if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
    return Array.isArray(fallback) ? [...fallback] : [];
  }

  const raw = process.env[key];
  if (raw === undefined || raw === null) {
    return Array.isArray(fallback) ? [...fallback] : [];
  }

  const text = String(raw).trim();
  if (!text) return [];

  return text
    .split(',')
    .map((item) => Number(String(item || '').trim()))
    .filter((item) => Number.isInteger(item));
}

function pickList(key, fallback = []) {
  const value = process.env[key];
  if (value === undefined || value === null || String(value).trim() === '') {
    return Array.isArray(fallback) ? [...fallback] : [];
  }

  return String(value)
    .split(',')
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function safeReadText(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf-8');
  } catch (_) {
    return fallback;
  }
}

function validateRequiredConfig() {
  const missing = REQUIRED_ENV_KEYS.filter((key) => {
    const value = process.env[key];
    return typeof value !== 'string' || value.trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `[config] Missing required env vars: ${missing.join(', ')}. ` +
      'Please set them in your environment or .env before startup.'
    );
  }

  const inboundGlobal = pickNum('INBOUND_GLOBAL_MAX_CONCURRENCY', 3);
  const inboundGeneral = pickNum('INBOUND_GENERAL_MAX_CONCURRENCY', 2);
  const inboundAdmin = pickNum('INBOUND_ADMIN_MAX_CONCURRENCY', 1);
  const inboundPerUser = pickNum('INBOUND_PER_USER_MAX_INFLIGHT', 1);
  const privateInboundGlobal = pickNum('PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY', 1);
  const privateInboundGeneral = pickNum('PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY', 0);
  const privateInboundAdmin = pickNum('PRIVATE_INBOUND_ADMIN_MAX_CONCURRENCY', 1);
  const privateInboundPerUser = pickNum('PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT', 1);
  const foregroundGlobal = pickNum('FOREGROUND_GLOBAL_MAX_CONCURRENCY', 10);
  const foregroundAdminReserved = pickNum('FOREGROUND_ADMIN_RESERVED_SLOTS', 1);
  const foregroundPerUser = pickNum('FOREGROUND_PER_USER_MAX_INFLIGHT', 1);
  const inboundValues = [
    ['INBOUND_GLOBAL_MAX_CONCURRENCY', inboundGlobal],
    ['INBOUND_GENERAL_MAX_CONCURRENCY', inboundGeneral],
    ['INBOUND_ADMIN_MAX_CONCURRENCY', inboundAdmin],
    ['INBOUND_PER_USER_MAX_INFLIGHT', inboundPerUser],
    ['PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY', privateInboundGlobal],
    ['PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY', privateInboundGeneral],
    ['PRIVATE_INBOUND_ADMIN_MAX_CONCURRENCY', privateInboundAdmin],
    ['PRIVATE_INBOUND_PER_USER_MAX_INFLIGHT', privateInboundPerUser],
    ['FOREGROUND_GLOBAL_MAX_CONCURRENCY', foregroundGlobal],
    ['FOREGROUND_ADMIN_RESERVED_SLOTS', foregroundAdminReserved],
    ['FOREGROUND_PER_USER_MAX_INFLIGHT', foregroundPerUser]
  ];

  for (const [key, value] of inboundValues) {
    const min = key === 'PRIVATE_INBOUND_GENERAL_MAX_CONCURRENCY' || key === 'PRIVATE_INBOUND_ADMIN_MAX_CONCURRENCY'
      || key === 'PRIVATE_INBOUND_GLOBAL_MAX_CONCURRENCY'
      ? 0
      : 1;
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`[config] ${key} must be an integer >= ${min}.`);
    }
  }
}

module.exports = {
  loadEnvironment,
  loadLocalEnvFallback,
  pick,
  pickBool,
  pickIntList,
  pickList,
  pickNum,
  REQUIRED_ENV_KEYS,
  safeReadText,
  validateRequiredConfig
};

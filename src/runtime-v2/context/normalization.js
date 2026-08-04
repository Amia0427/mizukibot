'use strict';

const { trimTextByTokenBudget } = require('../../../utils/contextBudget');

function normalizeRuntimeTimestampMs(value = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric === 0) return 0;
  const abs = Math.abs(numeric);
  return abs >= 1000000000 && abs < 1000000000000
    ? numeric * 1000
    : numeric;
}

function normalizeRuntimeDate(value = null) {
  if (value === null || value === undefined || value === '') return new Date();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const timestampMs = normalizeRuntimeTimestampMs(value);
  if (timestampMs !== null) {
    const date = new Date(timestampMs);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const text = normalizeText(value);
  if (text) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

function compactRuntimeLineValue(value = '', maxTokens = 120) {
  const text = normalizeText(value).replace(/\s+/g, ' ');
  if (!text) return '';
  return trimTextByTokenBudget(text, Math.max(16, Number(maxTokens || 120) || 120), 'tail');
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function hashText(value = '') {
  const raw = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

module.exports = {
  compactRuntimeLineValue,
  hashText,
  normalizeArray,
  normalizeObject,
  normalizeRuntimeDate,
  normalizeRuntimeTimestampMs,
  normalizeText
};

const config = require('../../config');
const { safeReadText } = require('./storage');

function appendJsonLine(filePath, payload, options = {}) {
  const { getJsonLineWriter } = require('../storeRegistry');
  const writer = getJsonLineWriter(filePath, {
    debounceMs: Math.max(0, Number(config.HOT_STORE_DEBOUNCE_MS || 250) || 250),
    maxDelayMs: Math.max(0, Number(config.HOT_STORE_MAX_DELAY_MS || 2000) || 2000)
  });
  writer.append(payload);
  if (options.flushNow === true) writer.flushSync();
}

function readJsonLines(filePath) {
  const raw = safeReadText(filePath, '').trim();
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = {
  appendJsonLine,
  readJsonLines
};

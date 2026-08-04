'use strict';

const MEMORY_STORAGE_MODES = Object.freeze([
  'legacy_compat',
  'v3_shadow',
  'v3_only'
]);

function resolveMemoryStorageMode(value = '') {
  const mode = String(value || '').trim().toLowerCase();
  return MEMORY_STORAGE_MODES.includes(mode) ? mode : 'legacy_compat';
}

module.exports = {
  MEMORY_STORAGE_MODES,
  resolveMemoryStorageMode
};

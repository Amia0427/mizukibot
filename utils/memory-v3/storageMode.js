'use strict';

const {
  MEMORY_STORAGE_MODES,
  resolveMemoryStorageMode
} = require('../../config/memoryStorageRuntime');

function isLegacyMemoryReadable(mode = '') {
  return resolveMemoryStorageMode(mode) !== 'v3_only';
}

function isLegacyMemoryWritable(mode = '') {
  return resolveMemoryStorageMode(mode) === 'legacy_compat';
}

function isLegacyMemoryShadowEnabled(mode = '') {
  return resolveMemoryStorageMode(mode) === 'v3_shadow';
}

function createLegacyStorageModeError(mode = '') {
  const error = new Error(`Legacy memory storage is disabled in ${resolveMemoryStorageMode(mode)} mode`);
  error.code = 'MEMORY_LEGACY_STORAGE_DISABLED';
  return error;
}

function assertLegacyMemoryReadable(mode = '') {
  if (!isLegacyMemoryReadable(mode)) throw createLegacyStorageModeError(mode);
}

function assertLegacyMemoryWritable(mode = '') {
  if (!isLegacyMemoryWritable(mode)) throw createLegacyStorageModeError(mode);
}

module.exports = {
  MEMORY_STORAGE_MODES,
  assertLegacyMemoryReadable,
  assertLegacyMemoryWritable,
  isLegacyMemoryReadable,
  isLegacyMemoryShadowEnabled,
  isLegacyMemoryWritable,
  resolveMemoryStorageMode
};

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

module.exports = {
  MEMORY_STORAGE_MODES,
  isLegacyMemoryReadable,
  isLegacyMemoryWritable,
  resolveMemoryStorageMode
};

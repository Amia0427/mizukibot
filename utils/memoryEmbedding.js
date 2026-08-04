'use strict';

const config = require('../config');
const {
  cosineArray,
  embedText,
  isEmbeddingConfigured
} = require('./memoryEmbeddingClient');

function shouldUseRemoteEmbedding() {
  return Boolean(
    config.MEMORY_HYBRID_RECALL_ENABLED
    && config.MEMORY_EMBEDDING_ENABLED
    && isEmbeddingConfigured()
  );
}

async function requestEmbedding(text, options = {}) {
  if (!options.force && !shouldUseRemoteEmbedding()) return null;
  return embedText(text, options);
}

module.exports = {
  cosineArray,
  requestEmbedding,
  shouldUseRemoteEmbedding
};

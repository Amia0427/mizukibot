const config = require('../../../config');
const {
  cosineArray,
  embedText,
  isEmbeddingConfigured
} = require('../../../utils/memoryEmbeddingClient');
const { semanticScoreDoc } = require('../../../utils/memorySemanticIndex');

function shouldUseRemoteEmbedding() {
  return Boolean(config.MEMORY_HYBRID_RECALL_ENABLED && config.MEMORY_EMBEDDING_ENABLED && isEmbeddingConfigured());
}

async function requestEmbedding(text, options = {}) {
  if (!options.force && !shouldUseRemoteEmbedding()) return null;
  return embedText(text, options);
}

function calcEmbeddingScore(_query, doc, options = {}) {
  return semanticScoreDoc(options.queryEmbedding || null, doc);
}

module.exports = {
  calcEmbeddingScore,
  cosineArray,
  requestEmbedding,
  shouldUseRemoteEmbedding
};

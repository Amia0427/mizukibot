const {
  cosineArray,
  requestEmbedding,
  shouldUseRemoteEmbedding
} = require('../../../utils/memoryEmbedding');
const { semanticScoreDoc } = require('../../../utils/memorySemanticIndex');

function calcEmbeddingScore(_query, doc, options = {}) {
  return semanticScoreDoc(options.queryEmbedding || null, doc);
}

module.exports = {
  calcEmbeddingScore,
  cosineArray,
  requestEmbedding,
  shouldUseRemoteEmbedding
};

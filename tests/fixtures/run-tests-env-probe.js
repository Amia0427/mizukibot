const config = require('../../config');
const { getModelHttpTransportStatus } = require('../../src/model/http/model-post.chunk');

console.log(JSON.stringify({
  env: {
    MODEL_TLS_IMPERSONATION_ENABLED: process.env.MODEL_TLS_IMPERSONATION_ENABLED,
    MODEL_TLS_IMPERSONATION_STREAM_ENABLED: process.env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED,
    MEMORY_CLI_RERANK_ENABLED: process.env.MEMORY_CLI_RERANK_ENABLED
  },
  config: {
    MODEL_TLS_IMPERSONATION_ENABLED: config.MODEL_TLS_IMPERSONATION_ENABLED,
    MODEL_TLS_IMPERSONATION_STREAM_ENABLED: config.MODEL_TLS_IMPERSONATION_STREAM_ENABLED,
    MEMORY_CLI_RERANK_ENABLED: config.MEMORY_CLI_RERANK_ENABLED
  },
  transport: getModelHttpTransportStatus()
}));

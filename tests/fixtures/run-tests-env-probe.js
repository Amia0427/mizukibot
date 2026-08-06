const config = require('../../config');
const { getModelHttpTransportStatus } = require('../../src/model/http/model-post.chunk');

console.log(JSON.stringify({
  env: {
    TEST_TEMP_ROOT: process.env.TEST_TEMP_ROOT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    MODEL_TLS_IMPERSONATION_ENABLED: process.env.MODEL_TLS_IMPERSONATION_ENABLED,
    MODEL_TLS_IMPERSONATION_STREAM_ENABLED: process.env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED,
    MEMORY_CLI_RERANK_ENABLED: process.env.MEMORY_CLI_RERANK_ENABLED,
    NAPCAT_HTTP_API_BASE_URL: process.env.NAPCAT_HTTP_API_BASE_URL
  },
  config: {
    MODEL_TLS_IMPERSONATION_ENABLED: config.MODEL_TLS_IMPERSONATION_ENABLED,
    MODEL_TLS_IMPERSONATION_STREAM_ENABLED: config.MODEL_TLS_IMPERSONATION_STREAM_ENABLED,
    MEMORY_CLI_RERANK_ENABLED: config.MEMORY_CLI_RERANK_ENABLED,
    NAPCAT_HTTP_API_BASE_URL: config.NAPCAT_HTTP_API_BASE_URL
  },
  transport: getModelHttpTransportStatus()
}));

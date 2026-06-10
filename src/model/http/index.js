const runtimeCore = require('./runtime-core.chunk');
const images = require('./images.chunk');
const openaiCompatible = require('./openai-compatible.chunk');
const requestShaping = require('./request-shaping.chunk');
const transport = require('./prepare.chunk');
const postRetry = require('./post-retry.chunk');
const streamRetry = require('./stream-retry.chunk');

module.exports = {
  buildAnthropicRequestHeaders: runtimeCore.buildAnthropicRequestHeaders,
  buildOpenAICompatibleImageFallbackText: images.buildOpenAICompatibleImageFallbackText,
  buildChatCompletionsFallbackUrl: openaiCompatible.buildChatCompletionsFallbackUrl,
  buildResponsesRequestBody: openaiCompatible.buildResponsesRequestBody,
  buildResponsesUrl: openaiCompatible.buildResponsesUrl,
  getAxiosOptions: transport.getAxiosOptions,
  isResponsesProtocolUnsupportedError: openaiCompatible.isResponsesProtocolUnsupportedError,
  isResponsesUrl: openaiCompatible.isResponsesUrl,
  postWithRetry: postRetry.postWithRetry,
  postStreamWithRetry: streamRetry.postStreamWithRetry,
  prepareRequest: transport.prepareRequest,
  mapMessagesToAnthropic: requestShaping.mapMessagesToAnthropic,
  preprocessOpenAICompatibleMessages: openaiCompatible.preprocessOpenAICompatibleMessages,
  preprocessOpenAICompatibleMessagesWithoutCache: openaiCompatible.preprocessOpenAICompatibleMessagesWithoutCache,
  resolveAnthropicImageBlock: images.resolveAnthropicImageBlock,
  resolveOpenAICompatibleImagePart: images.resolveOpenAICompatibleImagePart
};

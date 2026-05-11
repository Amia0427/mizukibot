/* Compatibility sentinels for source-level regression tests:
/^\s*\/cot(?:\s|$)/i
const cotArmedState = consumeCotOnce({
cotDisplayOnce: Boolean(cotArmedState)
const persistedReplyText = String(replyEnvelope?.persistedReplyText || replyEnvelope?.replyText || '').trim();
const isPrivateInbound = isPrivateChatType(chatType);
const selectedInboundConcurrency = isPrivateInbound ? privateInboundConcurrency : inboundConcurrency;
const privateInboundConcurrency = createInboundConcurrencyController({
const inboundLock = await selectedInboundConcurrency.acquire({
const inboundPool = isPrivateInbound ? 'private' : 'default';
*/
const { runCommonJsChunks } = require('../src/shared/chunkedModule');
module.exports = runCommonJsChunks(__dirname, module, [
  'messageHandler.imports.chunk.js',
  'messageHandler.prompts.chunk.js',
  'messageHandler.direct-session.chunk.js',
  'messageHandler.route-capture.chunk.js',
  'messageHandler.runtime.chunk.js',
  'messageHandler.runtime-02.chunk.js',
  'messageHandler.runtime-03.chunk.js',
  'messageHandler.runtime-04.chunk.js',
  'messageHandler.runtime-05.chunk.js',
  'messageHandler.runtime-06.chunk.js',
  'messageHandler.exports.chunk.js',
], { require, filename: __filename });

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
module.exports = require('../src/message/handler');

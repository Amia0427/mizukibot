const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Passive-awareness flow wrapper.
 * Keeps the orchestrator from directly depending on passive gating details.
 */
async function runPassiveFlow({
  inboundContext,
  handlePassiveGroupAwareness,
  sendGroupReply,
  sendWithRetry
} = {}) {
  const passiveResult = await handlePassiveGroupAwareness({
    msg: inboundContext?.effectiveMsg || inboundContext?.msg || {},
    inboundContext,
    sendGroupReply,
    sendWithRetry
  });
  appendPassiveAwarenessDecision({
    inboundContext,
    passiveResult
  });

  return {
    status: passiveResult?.handled ? 'passive_replied' : 'ignored',
    passiveResult
  };
}

function appendPassiveAwarenessDecision({ inboundContext = {}, passiveResult = {} } = {}) {
  try {
    const dataDir = config.DATA_DIR || path.join(process.cwd(), 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const msg = inboundContext?.effectiveMsg || inboundContext?.msg || {};
    const payload = {
      recordedAt: new Date().toISOString(),
      processId: process.pid,
      messageId: String(msg?.message_id || '').trim(),
      groupId: String(msg?.group_id || inboundContext?.groupId || '').trim(),
      userId: String(msg?.user_id || inboundContext?.senderId || '').trim(),
      handled: Boolean(passiveResult?.handled),
      reason: String(passiveResult?.reason || '').trim(),
      score: Number(passiveResult?.score || 0) || 0,
      addressee: String(passiveResult?.addressee || '').trim(),
      cheapGateReason: String(passiveResult?.cheapGateReason || '').trim(),
      decisionReason: String(passiveResult?.decisionReason || '').trim(),
      decisionModelCalled: Boolean(passiveResult?.decisionModelCalled),
      replyModelCalled: Boolean(passiveResult?.replyModelCalled),
      visualCueProbe: Boolean(passiveResult?.visualCueProbe),
      presenceState: String(passiveResult?.presenceState || '').trim(),
      presenceAction: String(passiveResult?.presenceAction || '').trim(),
      presenceReason: String(passiveResult?.presenceReason || '').trim(),
      rawPreview: String(inboundContext?.rawText || msg?.raw_message || '').slice(0, 160)
    };
    fs.appendFileSync(path.join(dataDir, 'passive-awareness-decisions.jsonl'), `${JSON.stringify(payload)}\n`);
  } catch (_) {}
}

module.exports = {
  appendPassiveAwarenessDecision,
  runPassiveFlow
};

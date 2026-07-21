'use strict';

const core = require('./core');
const presence = require('./presence-runtime');
const prompt = require('./prompt-runtime');
const model = require('./model-runtime');
const reply = require('./reply');

module.exports = {
  forcePassiveGroupInterjection: reply.forcePassiveGroupInterjection,
  handlePassiveGroupAwareness: reply.handlePassiveGroupAwareness,
  isEnabledForGroup: core.isEnabledForGroup,
  getPresenceConfig: presence.getPresenceConfig,
  decidePresenceAction: presence.decidePresenceAction,
  scoreMessageTrigger: core.scoreMessageTrigger,
  parseDecision: prompt.parseDecision,
  buildDecisionPrompt: prompt.buildDecisionPrompt,
  buildReplyPrompt: prompt.buildReplyPrompt,
  buildPassiveReplySystemMessages: model.buildPassiveReplySystemMessages,
  buildCompactPersonaPrompt: core.buildCompactPersonaPrompt,
  buildConversationWindow: core.buildConversationWindow,
  analyzeConversationWindow: core.analyzeConversationWindow,
  detectPassiveAddressee: core.detectPassiveAddressee,
  classifyPassiveReplyType: core.classifyPassiveReplyType,
  shouldGatePassiveReply: core.shouldGatePassiveReply,
  shouldSuppressPresenceAck: core.shouldSuppressPresenceAck,
  shouldSuppressTrivialPresenceReply: core.shouldSuppressTrivialPresenceReply,
  cheapRuleGate: model.cheapRuleGate,
  isNoiseText: core.isNoiseText,
  trimReplyText: core.trimReplyText
};

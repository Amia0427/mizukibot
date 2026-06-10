const passiveAwareness = require('./index');

module.exports = {
  cheapRuleGate: passiveAwareness.cheapRuleGate,
  isEnabledForGroup: passiveAwareness.isEnabledForGroup,
  isNoiseText: passiveAwareness.isNoiseText,
  scoreMessageTrigger: passiveAwareness.scoreMessageTrigger,
  shouldGatePassiveReply: passiveAwareness.shouldGatePassiveReply
};

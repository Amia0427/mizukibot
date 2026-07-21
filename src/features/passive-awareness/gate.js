const {
  isEnabledForGroup,
  isNoiseText,
  scoreMessageTrigger,
  shouldGatePassiveReply
} = require('./core');
const { cheapRuleGate } = require('./model-runtime');

module.exports = {
  cheapRuleGate,
  isEnabledForGroup,
  isNoiseText,
  scoreMessageTrigger,
  shouldGatePassiveReply
};

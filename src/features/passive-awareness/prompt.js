const { buildCompactPersonaPrompt } = require('./core');
const {
  buildDecisionPrompt,
  buildReplyPrompt,
  parseDecision
} = require('./prompt-runtime');

module.exports = {
  buildCompactPersonaPrompt,
  buildDecisionPrompt,
  buildReplyPrompt,
  parseDecision
};

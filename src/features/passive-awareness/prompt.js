const passiveAwareness = require('./index');

module.exports = {
  buildCompactPersonaPrompt: passiveAwareness.buildCompactPersonaPrompt,
  buildDecisionPrompt: passiveAwareness.buildDecisionPrompt,
  buildReplyPrompt: passiveAwareness.buildReplyPrompt,
  parseDecision: passiveAwareness.parseDecision
};

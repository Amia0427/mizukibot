const planning = {
  ...require('./prompt-normalizer.chunk'),
  ...require('./dynamic-plan.chunk'),
  ...require('./rule-decision.chunk')
};

module.exports = {
  buildLegacyExecutionPlanFromSteps: planning.buildLegacyExecutionPlanFromSteps,
  buildRuleBasedPlannerDecision: planning.buildRuleBasedPlannerDecision,
  convertPlannerDecisionToDirectChatDecision: planning.convertPlannerDecisionToDirectChatDecision,
  normalizePlannerDecisionV2: planning.normalizePlannerDecisionV2
};

function buildPlannerRuntimeConfig({ pick, pickNum, pickBool }) {
  return {
    PLAN_API_BASE_URL: pick('PLAN_API_BASE_URL', pick('PLANNER_API_BASE_URL', pick('PLAN_API_BASEURI', pick('PLANNER_API_BASEURI', '')))),
    PLAN_API_KEY: pick('PLAN_API_KEY', pick('PLANNER_API_KEY', pick('PLAN_APIKEY', pick('PLANNER_APIKEY', '')))),
    PLAN_MODEL: pick('PLAN_MODEL', pick('PLANNER_MODEL', 'gemini-3-pro-preview')),
    PLAN_REASONING_EFFORT: pick('PLAN_REASONING_EFFORT', pick('PLANNER_REASONING_EFFORT', 'off')),
    PLANNER_MAX_MODEL_CALLS: 1,
    PLANNER_SEMANTIC_REFINE_ENABLED: pickBool('PLANNER_SEMANTIC_REFINE_ENABLED', false),
    PLANNER_SEMANTIC_CONFIDENCE_THRESHOLD: Math.max(0, Math.min(1, pickNum('PLANNER_SEMANTIC_CONFIDENCE_THRESHOLD', 0.72))),
    PLANNER_ALLOW_MAIN_MODEL_FALLBACK: pickBool('PLANNER_ALLOW_MAIN_MODEL_FALLBACK', false)
  };
}

module.exports = {
  buildPlannerRuntimeConfig
};

const TOOL_BUCKETS = Object.freeze(['local_tools', 'global_tools', 'skills', 'mcp']);
const TASK_SHAPES = Object.freeze(['fast_reply', 'tool_augmented_reply', 'background_tool_task']);
const DIRECT_CHAT_PLANNER_VERSION = 'direct_chat_single_authority_v2';
const PLANNER_DECISION_VERSION = 'planner_decision_v2';
const PLANNER_PROTOCOL_VERSION = 'planner_request_v2';
const DYNAMIC_CONTEXT_PLAN_VERSION = 'dynamic_context_plan_v2';
const DEFAULT_PLANNER_TEMPERATURE = 0.1;
const DEFAULT_WORLDBOOK_PLANNER_CANDIDATE_LIMIT = 12;
const PLANNER_LATENCY_KEYS = Object.freeze([
  'planner_preflight_ms',
  'planner_model_ms',
  'planner_normalize_ms',
  'worldbook_lexical_ms',
  'worldbook_semantic_ms',
  'worldbook_rerank_ms',
  'prompt_assembly_ms'
]);

module.exports = {
  DEFAULT_PLANNER_TEMPERATURE,
  DEFAULT_WORLDBOOK_PLANNER_CANDIDATE_LIMIT,
  DIRECT_CHAT_PLANNER_VERSION,
  DYNAMIC_CONTEXT_PLAN_VERSION,
  PLANNER_DECISION_VERSION,
  PLANNER_LATENCY_KEYS,
  PLANNER_PROTOCOL_VERSION,
  TASK_SHAPES,
  TOOL_BUCKETS
};

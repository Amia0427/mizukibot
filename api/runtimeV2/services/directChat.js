const { normalizePlanStep, normalizeArray, normalizeObject } = require('../contracts');

const DIRECT_CHAT_EXCLUDED_TOOL_NAMES = new Set([
  'assistant_task_breakdown'
]);

function isExcludedDirectChatToolName(toolName = '') {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (!normalized) return true;
  if (DIRECT_CHAT_EXCLUDED_TOOL_NAMES.has(normalized)) return true;
  return false;
}

function parseToolCallArgs(toolCall = {}) {
  try {
    return JSON.parse(String(toolCall?.function?.arguments || '{}'));
  } catch (_) {
    return {};
  }
}

function buildDirectChatToolStep(toolCall = {}, attemptIndex = 1) {
  const parsedArgs = parseToolCallArgs(toolCall);
  const toolName = String(toolCall?.function?.name || '').trim();
  return {
    parsedArgs,
    toolName,
    step: {
      id: `direct_${toolName || 'tool'}_${attemptIndex}`,
      kind: toolName || 'tool',
      tool: toolName,
      instruction: `direct chat ${toolName || 'tool'} execution`,
      inputs: parsedArgs,
      successCriteria: 'tool result available',
      attempts: 0,
      evidence: [],
      blockingReason: ''
    }
  };
}

function isDirectChatRuntimeDependentStep(step = {}) {
  const toolName = String(step?.tool || '').trim();
  if (!toolName) return false;
  if (toolName === 'memory_cli') return true;
  if (toolName === 'web_fetch') {
    const inputs = normalizeObject(step?.inputs, {});
    const url = String(inputs.url || '').trim();
    const source = String(inputs.source || '').trim().toLowerCase();
    if (url) return false;
    return !url || new Set([
      'previous_search_best_match',
      'prior_search_best_match',
      'previous_web_search_best_match'
    ]).has(source);
  }
  return false;
}

function buildDirectChatExecutionBatches(items = [], stepSelector = (item) => item) {
  const batches = [];
  let currentParallelItems = [];
  for (const item of normalizeArray(items)) {
    const step = stepSelector(item);
    if (!step || typeof step !== 'object') continue;
    if (isDirectChatRuntimeDependentStep(step)) {
      if (currentParallelItems.length > 0) {
        const batchIndex = batches.length;
        batches.push({
          batchId: `batch-${batchIndex}`,
          batchIndex,
          mode: currentParallelItems.length > 1 ? 'parallel' : 'serial',
          items: currentParallelItems
        });
        currentParallelItems = [];
      }
      const batchIndex = batches.length;
      batches.push({
        batchId: `batch-${batchIndex}`,
        batchIndex,
        mode: 'serial',
        items: [item]
      });
      continue;
    }
    currentParallelItems.push(item);
  }
  if (currentParallelItems.length > 0) {
    const batchIndex = batches.length;
    batches.push({
      batchId: `batch-${batchIndex}`,
      batchIndex,
      mode: currentParallelItems.length > 1 ? 'parallel' : 'serial',
      items: currentParallelItems
    });
  }
  return batches;
}

function compileDirectChatToolCallsToPlan(toolCalls = [], existingPlan = null, options = {}) {
  const append = Boolean(options.append);
  const allowedTools = normalizeArray(options.allowedTools);
  const existingSteps = append
    ? normalizeArray(existingPlan?.steps).map((item) => ({ ...normalizeObject(item, {}) }))
    : [];
  const startIndex = existingSteps.length;
  const toolCallItems = normalizeArray(toolCalls).map((toolCall, index) => {
    const built = buildDirectChatToolStep(toolCall, index + 1);
    const allowed = !isExcludedDirectChatToolName(built.toolName) && allowedTools.includes(built.toolName);
    return {
      toolCall,
      parsedArgs: built.parsedArgs,
      toolName: built.toolName,
      step: normalizePlanStep({
        id: `direct_${built.toolName || 'tool'}_${startIndex + index + 1}`,
        action: built.toolName,
        args: built.parsedArgs,
        purpose: built.step.instruction,
        successCriteria: built.step.successCriteria,
        attempts: 0,
        evidence: [],
        blockingReason: '',
        toolCallId: String(toolCall?.id || '').trim(),
        ...(allowed ? {} : { preblocked: true, blockingReason: 'tool_not_allowed' })
      }, 'direct_chat', index)
    };
  });
  const batches = buildDirectChatExecutionBatches(toolCallItems, (item) => item.step);
  const compiledSteps = [];
  for (const batch of batches) {
    const batchId = String(batch?.batchId || '').trim();
    const batchIndex = Number.isFinite(Number(batch?.batchIndex)) ? Number(batch.batchIndex) : null;
    for (const item of normalizeArray(batch?.items)) {
      compiledSteps.push({
        ...normalizeObject(item?.step, {}),
        ...(batchId ? { batchId } : {}),
        ...(batchIndex !== null ? { batchIndex } : {}),
        directToolCallId: String(item?.toolCall?.id || '').trim()
      });
    }
  }
  const steps = existingSteps.concat(compiledSteps);

  const planner = normalizeObject(existingPlan?.planner, {});
  return {
    status: steps.length > 0 ? 'planned' : 'idle',
    currentStepId: steps.find((item) => String(item?.status || '').trim() !== 'completed')?.id || steps[0]?.id || '',
    steps,
    planner: {
      ...planner,
      directChatCompiledToolCalls: true
    },
    verification: null,
    rounds: normalizeArray(existingPlan?.rounds),
    finalPlan: null,
    finalExecLogs: [],
    lastRepairPlan: null
  };
}

module.exports = {
  buildDirectChatExecutionBatches,
  buildDirectChatToolStep,
  compileDirectChatToolCallsToPlan,
  isDirectChatRuntimeDependentStep,
  isExcludedDirectChatToolName,
  parseToolCallArgs
};

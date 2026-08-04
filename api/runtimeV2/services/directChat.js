const { normalizeToolStep, normalizeArray, normalizeObject } = require('../contracts');

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
  return parseToolCallArgsResult(toolCall).args;
}

function parseToolCallArgsResult(toolCall = {}) {
  const raw = String(toolCall?.function?.arguments || '{}');
  try {
    const args = JSON.parse(raw);
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { args: {}, error: 'tool arguments must be a JSON object' };
    }
    return { args, error: '' };
  } catch (error) {
    return { args: {}, error: `invalid tool arguments: ${String(error?.message || 'invalid JSON')}` };
  }
}

function buildDirectChatToolStep(toolCall = {}, attemptIndex = 1) {
  const parsed = parseToolCallArgsResult(toolCall);
  const parsedArgs = parsed.args;
  const toolName = String(toolCall?.function?.name || '').trim();
  return {
    parsedArgs,
    parseError: parsed.error,
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

module.exports = {
  buildDirectChatExecutionBatches,
  buildDirectChatToolStep,
  isDirectChatRuntimeDependentStep,
  isExcludedDirectChatToolName,
  parseToolCallArgs,
  parseToolCallArgsResult
};

const config = require('../config');
const { addMemoryItem, retrieveRelevantMemories, retrieveRelevantMemoriesAsync } = require('./vectorMemory');

function sanitizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeOutcome(value) {
  const outcome = String(value || '').trim().toLowerCase();
  if (outcome === 'success' || outcome === 'failure') return outcome;
  return 'unknown';
}

function buildTaskMemoryText(item = {}) {
  const lines = [];

  if (item.taskType) lines.push(`task type: ${item.taskType}`);
  if (item.trigger) lines.push(`trigger: ${item.trigger}`);
  if (item.strategy) lines.push(`strategy: ${item.strategy}`);
  if (item.avoid) lines.push(`avoid: ${item.avoid}`);
  if (item.outcome) lines.push(`outcome: ${item.outcome}`);

  return lines.join('\n').trim();
}

function addTaskMemory(userId, task = {}) {
  if (!config.TASK_MEMORY_ENABLED) return null;

  const taskType = sanitizeText(task.taskType || task.task_type);
  const trigger = sanitizeText(task.trigger);
  const strategy = sanitizeText(task.strategy);
  const avoid = sanitizeText(task.avoid);
  const outcome = normalizeOutcome(task.outcome);
  const confidence = Number(task.confidence);
  const text = buildTaskMemoryText({ taskType, trigger, strategy, avoid, outcome });

  if (!text || !taskType) return null;
  if (outcome !== 'success' && !avoid) return null;

  return addMemoryItem(
    userId,
    text,
    'fact',
    {
      source: task.source || 'task_extractor',
      confidence: Number.isFinite(confidence) ? confidence : 0.8,
      scopeType: 'task',
      taskType,
      routePolicyKey: sanitizeText(task.routePolicyKey || task.route_policy_key),
      topRouteType: sanitizeText(task.topRouteType || task.top_route_type),
      agentName: sanitizeText(task.agentName || task.agent_name),
      toolName: sanitizeText(task.toolName || task.tool_name),
      sessionId: sanitizeText(task.sessionId || task.session_id),
      channelId: sanitizeText(task.channelId || task.channel_id),
      status: sanitizeText(task.status),
      sourceKind: sanitizeText(task.sourceKind || task.source_kind),
      sourceSessionId: sanitizeText(task.sourceSessionId || task.source_session_id),
      participants: Array.isArray(task.participants) ? task.participants : [],
      entities: Array.isArray(task.entities) ? task.entities : [],
      relations: Array.isArray(task.relations) ? task.relations : [],
      outcome,
      memoryKind: 'task',
      fieldKey: 'task',
      semanticSlot: 'task',
      trigger,
      strategy,
      avoid
    },
    outcome === 'success' ? 1.12 : 0.98
  );
}

function retrieveRelevantTaskMemories(userId, query, topK = config.TASK_MEMORY_TOP_K || 3, options = {}) {
  if (!config.TASK_MEMORY_ENABLED) return [];

  return retrieveRelevantMemories(userId, query, topK, {
    ...options,
    scopeType: 'task'
  });
}

async function retrieveRelevantTaskMemoriesAsync(userId, query, topK = config.TASK_MEMORY_TOP_K || 3, options = {}) {
  if (!config.TASK_MEMORY_ENABLED) return [];

  return retrieveRelevantMemoriesAsync(userId, query, topK, {
    ...options,
    scopeType: 'task'
  });
}

function formatTaskMemories(hits = [], options = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0) return String(options.emptyText || '暂无相关任务经验');

  return list
    .map((item, index) => `${index + 1}. [task${item.taskType ? `|${item.taskType}` : ''}] ${item.text}`)
    .join('\n');
}

function formatTaskMemoriesCompat(hits = [], options = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0 && Object.prototype.hasOwnProperty.call(options, 'emptyText')) {
    return String(options.emptyText || '');
  }
  return formatTaskMemories(hits, options);
}

module.exports = {
  addTaskMemory,
  retrieveRelevantTaskMemories,
  retrieveRelevantTaskMemoriesAsync,
  formatTaskMemories: formatTaskMemoriesCompat
};

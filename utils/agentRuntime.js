const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const TASKS_DIR = path.join(config.DATA_DIR, 'agent_tasks');
const SAFE_TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function ensureTasksDir() {
  if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }
}

function sanitizeTaskId(taskId) {
  const id = normalizeText(taskId);
  if (!id) return '';
  // Strictly whitelist IDs to prevent path traversal via ../ style input.
  if (!SAFE_TASK_ID_RE.test(id)) return '';
  return id;
}

function taskFile(taskId) {
  ensureTasksDir();
  const id = sanitizeTaskId(taskId);
  if (!id) throw new Error('invalid task id');
  return path.join(TASKS_DIR, `${id}.json`);
}

function nowIso() {
  return new Date().toISOString();
}

function makeTaskId() {
  const random = crypto.randomBytes(6).toString('hex');
  return `task_${Date.now()}_${random}`;
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function cloneJson(value, fallback) {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function normalizeWorkspace(input = {}) {
  const workspace = input && typeof input === 'object' ? input : {};
  return {
    completed_steps: normalizeArray(workspace.completed_steps),
    failed_steps: normalizeArray(workspace.failed_steps),
    candidate_next_actions: normalizeArray(workspace.candidate_next_actions),
    evidence: normalizeArray(workspace.evidence),
    pending_facts: normalizeArray(workspace.pending_facts),
    drafts: normalizeArray(workspace.drafts)
  };
}

function normalizeStep(stepInput = {}, index = 0) {
  return {
    id: normalizeText(stepInput.id) || `step_${index + 1}`,
    kind: normalizeText(stepInput.kind || 'tool') || 'tool',
    name: normalizeText(stepInput.name),
    status: normalizeText(stepInput.status || 'running') || 'running',
    purpose: normalizeText(stepInput.purpose),
    input: stepInput.input && typeof stepInput.input === 'object' ? cloneJson(stepInput.input, {}) : {},
    output: Object.prototype.hasOwnProperty.call(stepInput, 'output') ? stepInput.output : null,
    error: normalizeText(stepInput.error),
    verification: stepInput.verification && typeof stepInput.verification === 'object'
      ? {
          ok: stepInput.verification.ok !== false,
          confidence: Number(stepInput.verification.confidence || 0) || 0,
          summary: normalizeText(stepInput.verification.summary),
          missing: normalizeArray(stepInput.verification.missing)
        }
      : null,
    started_at: normalizeText(stepInput.started_at) || nowIso(),
    completed_at: stepInput.completed_at || null
  };
}

function normalizeTask(task = {}) {
  return {
    id: normalizeText(task.id) || makeTaskId(),
    kind: normalizeText(task.kind || 'agent_run') || 'agent_run',
    status: normalizeText(task.status || 'running') || 'running',
    stage: normalizeText(task.stage || 'created') || 'created',
    user_id: normalizeText(task.user_id),
    goal: normalizeText(task.goal),
    input_text: normalizeText(task.input_text),
    source: normalizeText(task.source || 'chat') || 'chat',
    metadata: task.metadata && typeof task.metadata === 'object' ? cloneJson(task.metadata, {}) : {},
    success_criteria: normalizeArray(task.success_criteria),
    failure_reason: normalizeText(task.failure_reason),
    checkpoint: task.checkpoint && typeof task.checkpoint === 'object' ? cloneJson(task.checkpoint, {}) : null,
    workspace: normalizeWorkspace(task.workspace),
    steps: normalizeArray(task.steps).map((step, index) => normalizeStep(step, index)),
    artifacts: normalizeArray(task.artifacts),
    logs: normalizeArray(task.logs),
    result: Object.prototype.hasOwnProperty.call(task, 'result') ? task.result : null,
    created_at: normalizeText(task.created_at) || nowIso(),
    updated_at: normalizeText(task.updated_at) || nowIso(),
    completed_at: task.completed_at || null,
    failed_at: task.failed_at || null
  };
}

function writeTask(task) {
  const next = normalizeTask({
    ...task,
    updated_at: nowIso()
  });
  fs.writeFileSync(taskFile(next.id), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function createTask(input = {}) {
  const task = normalizeTask({
    id: makeTaskId(),
    kind: input.kind,
    status: 'running',
    stage: input.stage || 'created',
    user_id: input.userId,
    goal: input.goal,
    input_text: input.inputText,
    source: input.source,
    metadata: input.metadata,
    success_criteria: input.successCriteria,
    checkpoint: input.checkpoint || null,
    workspace: input.workspace,
    steps: [],
    artifacts: [],
    logs: [],
    result: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    completed_at: null,
    failed_at: null
  });

  return writeTask(task);
}

function loadTask(taskId) {
  const id = sanitizeTaskId(taskId);
  if (!id) return null;
  const task = safeReadJson(taskFile(id), null);
  return task ? normalizeTask(task) : null;
}

function listTasks(limit = 20) {
  ensureTasksDir();
  const max = Math.max(1, Math.min(100, Number(limit) || 20));
  const files = fs.readdirSync(TASKS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(TASKS_DIR, name));

  const tasks = files
    .map((filePath) => safeReadJson(filePath, null))
    .filter(Boolean)
    .map((task) => normalizeTask(task))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, max);

  return tasks;
}

function updateTask(taskId, mutator) {
  const current = loadTask(taskId);
  if (!current) return null;
  const mutated = typeof mutator === 'function' ? (mutator(current) || current) : current;
  return writeTask(mutated);
}

function appendTaskLog(taskId, entry) {
  return updateTask(taskId, (task) => {
    task.logs = normalizeArray(task.logs);
    task.logs.push({
      at: nowIso(),
      level: normalizeText(entry?.level || 'info') || 'info',
      type: normalizeText(entry?.type || 'event') || 'event',
      message: normalizeText(entry?.message),
      data: entry?.data && typeof entry.data === 'object' ? cloneJson(entry.data, null) : null
    });
    return task;
  });
}

function startTaskStep(taskId, stepInput = {}) {
  let stepId = '';
  updateTask(taskId, (task) => {
    task.steps = normalizeArray(task.steps);
    stepId = normalizeText(stepInput.id) || `step_${task.steps.length + 1}`;
    task.steps.push(normalizeStep({
      ...stepInput,
      id: stepId,
      status: 'running',
      started_at: nowIso(),
      completed_at: null
    }, task.steps.length));
    return task;
  });
  return stepId;
}

function finishTaskStep(taskId, stepId, result = {}) {
  let applied = false;
  const updatedTask = updateTask(taskId, (task) => {
    task.steps = normalizeArray(task.steps);
    const step = task.steps.find((item) => item.id === stepId);
    if (!step) return task;
    // Keep step completion idempotent so late/duplicate updates cannot overwrite
    // an already finalized status (for example after timeout fallback).
    if (step.completed_at || step.status === 'completed' || step.status === 'failed') {
      return task;
    }

    applied = true;
    step.status = result.ok === false ? 'failed' : 'completed';
    step.output = Object.prototype.hasOwnProperty.call(result, 'output') ? result.output : step.output;
    step.error = normalizeText(result.error);
    step.verification = result.verification && typeof result.verification === 'object'
      ? {
          ok: result.verification.ok !== false,
          confidence: Number(result.verification.confidence || 0) || 0,
          summary: normalizeText(result.verification.summary),
          missing: normalizeArray(result.verification.missing)
        }
      : step.verification;
    step.completed_at = nowIso();
    return task;
  });
  return applied ? updatedTask : null;
}

function addTaskArtifact(taskId, artifact = {}) {
  return updateTask(taskId, (task) => {
    task.artifacts = normalizeArray(task.artifacts);
    task.artifacts.push({
      type: normalizeText(artifact.type || 'note') || 'note',
      label: normalizeText(artifact.label),
      content: Object.prototype.hasOwnProperty.call(artifact, 'content') ? artifact.content : null,
      created_at: nowIso()
    });
    return task;
  });
}

function setTaskStage(taskId, stage, checkpoint = undefined) {
  return updateTask(taskId, (task) => {
    task.stage = normalizeText(stage) || task.stage;
    if (checkpoint !== undefined) {
      task.checkpoint = checkpoint && typeof checkpoint === 'object' ? cloneJson(checkpoint, {}) : null;
    }
    return task;
  });
}

function setTaskSuccessCriteria(taskId, criteria) {
  return updateTask(taskId, (task) => {
    task.success_criteria = normalizeArray(criteria).map((item) => normalizeText(item)).filter(Boolean);
    return task;
  });
}

function setTaskCheckpoint(taskId, checkpoint) {
  return updateTask(taskId, (task) => {
    task.checkpoint = checkpoint && typeof checkpoint === 'object' ? cloneJson(checkpoint, {}) : null;
    return task;
  });
}

function mergeWorkspace(taskId, patch = {}) {
  return updateTask(taskId, (task) => {
    const current = normalizeWorkspace(task.workspace);
    const next = patch && typeof patch === 'object' ? patch : {};
    task.workspace = {
      ...current,
      ...next,
      completed_steps: normalizeArray(next.completed_steps !== undefined ? next.completed_steps : current.completed_steps),
      failed_steps: normalizeArray(next.failed_steps !== undefined ? next.failed_steps : current.failed_steps),
      candidate_next_actions: normalizeArray(next.candidate_next_actions !== undefined ? next.candidate_next_actions : current.candidate_next_actions),
      evidence: normalizeArray(next.evidence !== undefined ? next.evidence : current.evidence),
      pending_facts: normalizeArray(next.pending_facts !== undefined ? next.pending_facts : current.pending_facts),
      drafts: normalizeArray(next.drafts !== undefined ? next.drafts : current.drafts)
    };
    return task;
  });
}

function appendWorkspaceItem(taskId, field, value, limit = 20) {
  const fieldName = normalizeText(field);
  const cap = Math.max(1, Math.min(200, Number(limit) || 20));
  return updateTask(taskId, (task) => {
    const workspace = normalizeWorkspace(task.workspace);
    if (!Array.isArray(workspace[fieldName])) {
      throw new Error(`Workspace field is not appendable: ${fieldName}`);
    }
    workspace[fieldName].push(value);
    if (workspace[fieldName].length > cap) {
      workspace[fieldName] = workspace[fieldName].slice(-cap);
    }
    task.workspace = workspace;
    return task;
  });
}

function completeTask(taskId, result = null) {
  return updateTask(taskId, (task) => {
    task.status = 'completed';
    task.stage = 'completed';
    task.result = result;
    task.failure_reason = '';
    task.completed_at = nowIso();
    return task;
  });
}

function failTask(taskId, error, checkpoint = undefined) {
  return updateTask(taskId, (task) => {
    task.status = 'failed';
    task.stage = 'failed';
    task.failure_reason = normalizeText(error || 'unknown error');
    task.result = {
      error: task.failure_reason
    };
    if (checkpoint !== undefined) {
      task.checkpoint = checkpoint && typeof checkpoint === 'object' ? cloneJson(checkpoint, {}) : null;
    }
    task.failed_at = nowIso();
    return task;
  });
}

module.exports = {
  TASKS_DIR,
  createTask,
  loadTask,
  listTasks,
  updateTask,
  appendTaskLog,
  startTaskStep,
  finishTaskStep,
  addTaskArtifact,
  setTaskStage,
  setTaskSuccessCriteria,
  setTaskCheckpoint,
  mergeWorkspace,
  appendWorkspaceItem,
  completeTask,
  failTask
};

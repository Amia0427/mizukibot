function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').trim();
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function defaultStableHash(value) {
  return stableStringify(value || {});
}

function summarizeToolResultText(result = '', maxChars = 4000) {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  const limit = Math.max(500, Number(maxChars || 0) || 4000);
  if (text.length <= limit) return text;
  const headSize = Math.floor(limit * 0.7);
  const tailSize = Math.max(200, limit - headSize - 120);
  return `${text.slice(0, headSize)}\n... [tool result truncated: ${text.length - limit} chars omitted] ...\n${text.slice(-tailSize)}`;
}

function inferStepKindFromTool(toolName = '') {
  const normalized = normalizeText(toolName);
  if (!normalized) return 'reply';
  if (normalized === 'memory_cli') return 'memory_cli';
  if (normalized === 'humanizer') return 'humanizer';
  return normalized === 'reply' ? 'reply' : 'tool';
}

function normalizeStepId(step = {}, fallbackPrefix = 'step', index = 0) {
  const raw = normalizeText(step?.id || step?.step);
  return raw || `${fallbackPrefix}_${index + 1}`;
}

function normalizePlanStep(rawStep = {}, source = 'planner', index = 0) {
  const step = normalizeObject(rawStep, {});
  const preferredTools = normalizeArray(step.preferredTools)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const action = normalizeText(step.action);
  const existingTool = normalizeText(step.tool);
  const stepTool = normalizeText(
    source === 'route'
      ? (preferredTools[0] || existingTool)
      : (action === 'reply' ? '' : (action || existingTool))
  );
  const instruction = source === 'route'
    ? normalizeText(step.instruction || step.step)
    : normalizeText(step.purpose || step.instruction || step.step);
  const successCriteria = source === 'route'
    ? normalizeText(step.successCheck || step.produces || instruction)
    : normalizeText(step.purpose || step.successCriteria || instruction);
  const batchId = normalizeText(step.batchId || step.batch_id);
  const batchIndexRaw = step?.batchIndex ?? step?.batch_index;
  const batchIndex = Number.isFinite(Number(batchIndexRaw)) ? Number(batchIndexRaw) : null;
  const dependsOn = normalizeArray(step.dependsOn ?? step.depends_on).map((item) => normalizeText(item)).filter(Boolean);

  return {
    id: normalizeStepId(step, source, index),
    kind: normalizeText(step.kind) || inferStepKindFromTool(stepTool),
    tool: stepTool,
    inputs: normalizeObject(
      source === 'route'
        ? step.inputs
        : step.args ?? step.inputs,
      {}
    ),
    instruction,
    successCriteria,
    status: normalizeText(step.status || 'pending') || 'pending',
    attempts: Number.isFinite(Number(step.attempts)) ? Math.max(0, Math.floor(Number(step.attempts))) : 0,
    evidence: normalizeArray(step.evidence).map((item) => normalizeObject(item, {})),
    blockingReason: normalizeText(step.blockingReason),
    optional: Boolean(step.optional),
    dependsOn,
    parallelGroup: normalizeText(step.parallelGroup || step.parallel_group),
    sideEffect: Boolean(step.sideEffect ?? step.side_effect),
    evidenceRequirement: normalizeObject(step.evidenceRequirement ?? step.evidence_requirement, {}),
    repairPolicy: normalizeObject(step.repairPolicy ?? step.repair_policy, {}),
    runtimeBinding: step.runtimeBinding === null
      ? null
      : normalizeObject(step.runtimeBinding ?? step.runtime_binding, null),
    source,
    routePreferredTools: source === 'route' ? preferredTools : normalizeArray(step.routePreferredTools).map((item) => normalizeText(item)).filter(Boolean),
    ...(batchId ? { batchId } : {}),
    ...(batchIndex !== null ? { batchIndex } : {})
  };
}

function normalizeExecutionEnvelope(rawEnvelope = {}, fallbackStep = {}, options = {}) {
  const normalizedOptions = normalizeObject(options, {});
  const envelope = normalizeObject(rawEnvelope, {});
  const step = normalizeObject(fallbackStep, {});
  const args = normalizeObject(envelope.args, normalizeObject(step.inputs, {}));
  const stableHash = typeof normalizedOptions.stableHash === 'function' ? normalizedOptions.stableHash : defaultStableHash;
  const argsHash = normalizeText(envelope.args_hash || envelope.argsHash || stableHash(args));
  const nowTs = typeof normalizedOptions.nowTs === 'function' ? normalizedOptions.nowTs : Date.now;
  const resultMaxChars = Number.isFinite(Number(normalizedOptions.resultMaxChars))
    ? Math.max(500, Number(normalizedOptions.resultMaxChars))
    : 4000;
  const source = normalizeText(envelope.source || normalizedOptions.source || 'dispatch') || 'dispatch';
  const stepId = normalizeText(envelope.step_id || envelope.stepId || step.id);
  const toolName = normalizeText(envelope.tool_name || envelope.toolName || step.tool);
  const batchId = normalizeText(envelope.batch_id || envelope.batchId || step.batchId || step.batch_id);
  const batchIndexRaw = envelope.batch_index ?? envelope.batchIndex ?? step.batchIndex ?? step.batch_index;
  const batchIndex = Number.isFinite(Number(batchIndexRaw)) ? Number(batchIndexRaw) : null;
  const rawStatus = normalizeText(envelope.status || 'failed') || 'failed';
  const durationMs = Number.isFinite(Number(envelope.duration_ms ?? envelope.durationMs))
    ? Math.max(0, Math.floor(Number(envelope.duration_ms ?? envelope.durationMs)))
    : 0;
  const normalized = {
    tool_call_id: normalizeText(envelope.tool_call_id || envelope.toolCallId) || `${stepId || 'step'}_${argsHash}_${nowTs()}`,
    step_id: stepId,
    tool_name: toolName,
    args_hash: argsHash,
    args,
    status: rawStatus,
    result: summarizeToolResultText(
      typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope.result ?? ''),
      resultMaxChars
    ),
    side_effect: Boolean(envelope.side_effect ?? envelope.sideEffect),
    retryable: Object.prototype.hasOwnProperty.call(envelope, 'retryable')
      ? envelope.retryable !== false
      : !['completed', 'blocked'].includes(rawStatus),
    attempt: Number.isFinite(Number(envelope.attempt)) ? Math.max(1, Math.floor(Number(envelope.attempt))) : Math.max(1, Number(step.attempts || 0) + 1),
    reused: Boolean(envelope.reused),
    duration_ms: durationMs,
    source
  };

  if (batchId) normalized.batch_id = batchId;
  if (batchIndex !== null) normalized.batch_index = batchIndex;
  if (envelope.memoryCliTurn) normalized.memoryCliTurn = normalizeObject(envelope.memoryCliTurn, {});
  if (Object.prototype.hasOwnProperty.call(envelope, 'invalidateMemoryPrompt')) {
    normalized.invalidateMemoryPrompt = Boolean(envelope.invalidateMemoryPrompt);
  }
  if (Object.prototype.hasOwnProperty.call(envelope, 'repairApplied')) {
    normalized.repairApplied = Boolean(envelope.repairApplied);
  }
  if (Object.prototype.hasOwnProperty.call(envelope, 'repairStrategy')) {
    normalized.repairStrategy = normalizeArray(envelope.repairStrategy);
  }
  if (Object.prototype.hasOwnProperty.call(envelope, 'blockedReason')) {
    normalized.blockedReason = normalizeText(envelope.blockedReason);
  }
  if (Object.prototype.hasOwnProperty.call(envelope, 'unsatisfiedRequirement')) {
    normalized.unsatisfiedRequirement = normalizeText(envelope.unsatisfiedRequirement);
  }
  if (Object.prototype.hasOwnProperty.call(envelope, 'runtimeBinding')) {
    normalized.runtimeBinding = envelope.runtimeBinding === null
      ? null
      : normalizeObject(envelope.runtimeBinding, {});
  }
  return normalized;
}

function normalizeAllowedToolSet(allowedTools = []) {
  return new Set(normalizeArray(allowedTools).map((item) => normalizeText(item)).filter(Boolean));
}

function validatePlannerExecutionPlan(executionPlan = null, options = {}) {
  const allowedTools = normalizeAllowedToolSet(options.allowedTools);
  const requireAllowedTools = options.requireAllowedTools !== false;
  const reasons = [];
  if (!executionPlan || typeof executionPlan !== 'object' || Array.isArray(executionPlan)) {
    return {
      ok: false,
      status: 'planner_invalid',
      reasons: [{ code: 'invalid_execution_plan', message: 'executionPlan must be an object.' }],
      steps: []
    };
  }
  if (!Array.isArray(executionPlan.steps)) {
    return {
      ok: false,
      status: 'planner_invalid',
      reasons: [{ code: 'invalid_steps', message: 'executionPlan.steps must be an array.' }],
      steps: []
    };
  }

  const plannerAllowedToolNames = normalizeArray(executionPlan.allowedToolNames ?? executionPlan.allowed_tools)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  if (
    Object.prototype.hasOwnProperty.call(executionPlan, 'allowedToolNames')
    && !Array.isArray(executionPlan.allowedToolNames)
  ) {
    reasons.push({
      code: 'invalid_allowed_tool_names',
      message: 'Planner allowedToolNames must be an array when provided.'
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(executionPlan, 'allowed_tools')
    && !Array.isArray(executionPlan.allowed_tools)
  ) {
    reasons.push({
      code: 'invalid_allowed_tool_names',
      message: 'Planner allowed_tools must be an array when provided.'
    });
  }
  for (const toolName of plannerAllowedToolNames) {
    if (requireAllowedTools && !allowedTools.has(toolName)) {
      reasons.push({
        code: 'allowed_tool_not_allowed',
        toolName,
        message: `Planner allowedToolNames contains disallowed tool: ${toolName}`
      });
    }
  }

  const normalizedSteps = executionPlan.steps.map((step, index) => normalizePlanStep(step, 'direct_chat', index));
  const ids = new Set();
  for (let index = 0; index < normalizedSteps.length; index += 1) {
    const step = normalizedSteps[index];
    const stepId = normalizeText(step.id);
    const toolName = normalizeText(step.tool);
    if (!stepId) {
      reasons.push({ code: 'missing_step_id', stepId, message: 'Planner step id is required.' });
    }
    if (ids.has(stepId)) {
      reasons.push({ code: 'duplicate_step_id', stepId, message: `Duplicate planner step id: ${stepId}` });
    }
    ids.add(stepId);
    if (step.kind !== 'reply' && !toolName) {
      reasons.push({ code: 'missing_tool', stepId, message: `Planner step ${stepId} is missing tool.` });
    }
    if (step.kind !== 'reply' && requireAllowedTools && (!allowedTools.has(toolName))) {
      reasons.push({ code: 'tool_not_allowed', stepId, toolName, message: `Planner step ${stepId} requested disallowed tool: ${toolName}` });
    }
    const rawStep = normalizeObject(executionPlan.steps[index], {});
    const rawArgs = rawStep.args ?? rawStep.inputs ?? {};
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      reasons.push({ code: 'invalid_args', stepId, toolName, message: `Planner step ${stepId} args must be an object.` });
    }
    const rawDependsOn = rawStep.dependsOn ?? rawStep.depends_on;
    if (rawDependsOn !== undefined && !Array.isArray(rawDependsOn)) {
      reasons.push({
        code: 'invalid_depends_on',
        stepId,
        toolName,
        message: `Planner step ${stepId} dependsOn must be an array when provided.`
      });
    }
  }

  for (const step of normalizedSteps) {
    for (const dep of normalizeArray(step.dependsOn)) {
      if (dep === step.id) {
        reasons.push({ code: 'depends_on_self', stepId: step.id, dependsOn: dep, message: `Planner step ${step.id} depends on itself.` });
      } else if (!ids.has(dep)) {
        reasons.push({ code: 'depends_on_unknown', stepId: step.id, dependsOn: dep, message: `Planner step ${step.id} depends on unknown step ${dep}.` });
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(normalizedSteps.map((step) => [step.id, step]));
  const visit = (stepId, path = []) => {
    if (!stepId || visited.has(stepId)) return false;
    if (visiting.has(stepId)) {
      reasons.push({
        code: 'depends_on_cycle',
        stepId,
        path: path.concat([stepId]),
        message: `Planner dependencies contain a cycle at ${stepId}.`
      });
      return true;
    }
    visiting.add(stepId);
    const step = byId.get(stepId);
    for (const dep of normalizeArray(step?.dependsOn)) {
      if (byId.has(dep)) visit(dep, path.concat([stepId]));
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };
  for (const step of normalizedSteps) visit(step.id, []);

  return {
    ok: reasons.length === 0,
    status: reasons.length === 0 ? 'validated' : 'planner_invalid',
    reasons,
    steps: reasons.length === 0 ? normalizedSteps : [],
    stepCount: normalizedSteps.length,
    allowedToolNames: plannerAllowedToolNames.length > 0 ? plannerAllowedToolNames : [...allowedTools]
  };
}

function extractExecLogsFromEnvelopes(envelopes = []) {
  return normalizeArray(envelopes).map((envelope) => ({
    id: envelope.step_id,
    action: envelope.tool_name,
    args: normalizeObject(envelope.args, {}),
    ok: normalizeText(envelope.status) === 'completed',
    result: normalizeText(envelope.status) === 'completed' ? String(envelope.result || '') : '',
    error: normalizeText(envelope.status) === 'completed' ? '' : String(envelope.result || ''),
    unsatisfiedRequirement: normalizeText(envelope.unsatisfiedRequirement),
    runtimeBinding: Object.prototype.hasOwnProperty.call(envelope, 'runtimeBinding')
      ? (envelope.runtimeBinding === null ? null : normalizeObject(envelope.runtimeBinding, {}))
      : undefined,
    batchId: normalizeText(envelope.batch_id),
    batchIndex: Number.isFinite(Number(envelope.batch_index)) ? Number(envelope.batch_index) : null,
    duration_ms: Number.isFinite(Number(envelope.duration_ms)) ? Number(envelope.duration_ms) : 0,
    source: normalizeText(envelope.source)
  }));
}

function buildSyntheticToolMessages(envelopes = []) {
  const toolCalls = [];
  const toolMessages = [];
  for (const envelope of normalizeArray(envelopes)) {
    const toolCallId = normalizeText(envelope.tool_call_id);
    if (!toolCallId || !normalizeText(envelope.tool_name)) continue;
    toolCalls.push({
      id: toolCallId,
      type: 'function',
      function: {
        name: normalizeText(envelope.tool_name),
        arguments: JSON.stringify(normalizeObject(envelope.args, {}))
      }
    });
    toolMessages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: String(envelope.result || '')
    });
  }
  return {
    assistantToolCallMessage: toolCalls.length > 0
      ? { role: 'assistant', content: '', tool_calls: toolCalls }
      : null,
    toolMessages
  };
}

function buildToolEvidenceBundle(state = {}, options = {}) {
  const resultMaxChars = Number.isFinite(Number(options.resultMaxChars))
    ? Math.max(500, Number(options.resultMaxChars))
    : 4000;
  const stepsById = new Map(normalizeArray(state.plan?.steps).map((step) => [normalizeText(step.id), step]));
  const seen = new Set();
  const envelopes = [];
  const addEnvelope = (rawEnvelope = {}, fallbackStep = {}, source = 'dispatch') => {
    const normalized = normalizeExecutionEnvelope(rawEnvelope, fallbackStep, {
      ...options,
      resultMaxChars,
      source: rawEnvelope?.source || source
    });
    const key = normalizeText(normalized.tool_call_id)
      || `${normalizeText(normalized.step_id)}:${normalizeText(normalized.tool_name)}:${normalizeText(normalized.args_hash)}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    envelopes.push(normalized);
  };

  for (const envelope of normalizeArray(state.execution?.toolResults)) {
    addEnvelope(envelope, stepsById.get(normalizeText(envelope?.step_id)) || {}, envelope?.source || 'dispatch');
  }
  for (const step of normalizeArray(state.plan?.steps)) {
    for (const envelope of normalizeArray(step.evidence)) {
      addEnvelope(envelope, step, envelope?.source || 'plan_evidence');
    }
  }

  const globalEvidence = [];
  const globalEvidenceText = normalizeText(state.memory?.globalToolEvidence);
  if (globalEvidenceText) {
    globalEvidence.push({
      source: 'global_preflight',
      originalSource: 'global_preflight',
      result: summarizeToolResultText(globalEvidenceText, resultMaxChars)
    });
  }
  for (const item of normalizeArray(state.memory?.globalToolResults)) {
    const normalized = normalizeObject(item, {});
    const result = summarizeToolResultText(normalized.result ?? normalized.content ?? normalized.text ?? '', resultMaxChars);
    if (!result) continue;
    globalEvidence.push({
      source: 'global_preflight',
      originalSource: normalizeText(normalized.source || 'global_preflight') || 'global_preflight',
      tool_name: normalizeText(normalized.tool_name || normalized.toolName || normalized.name),
      result
    });
  }
  for (const item of globalEvidence) {
    envelopes.push(normalizeExecutionEnvelope({
      tool_call_id: normalizeText(item.tool_call_id) || `global_preflight_${envelopes.length + 1}`,
      step_id: normalizeText(item.step_id) || `global_preflight_${envelopes.length + 1}`,
      tool_name: normalizeText(item.tool_name) || 'global_preflight',
      args: {},
      status: 'completed',
      result: item.result,
      retryable: false,
      duration_ms: 0,
      source: item.source || 'global_preflight'
    }, {}, {
      ...options,
      resultMaxChars,
      source: item.source || 'global_preflight'
    }));
  }

  const dispatchEnvelopes = envelopes.filter((item) => normalizeText(item.source) !== 'global_preflight');
  const synthetic = buildSyntheticToolMessages(dispatchEnvelopes);
  const execLogs = normalizeArray(state.plan?.finalExecLogs).length > 0
    ? normalizeArray(state.plan.finalExecLogs)
    : extractExecLogsFromEnvelopes(dispatchEnvelopes);
  return {
    finalPlan: state.plan?.finalPlan || null,
    execLogs,
    envelopes,
    globalEvidence,
    assistantToolCallMessage: synthetic.assistantToolCallMessage,
    toolMessages: synthetic.toolMessages,
    toolResultCount: dispatchEnvelopes.length,
    globalEvidenceCount: globalEvidence.length
  };
}

function createCapabilityDescriptor(raw = {}) {
  const descriptor = normalizeObject(raw, {});
  return {
    name: normalizeText(descriptor.name || descriptor.toolName || descriptor.functionName),
    kind: normalizeText(descriptor.kind || 'tool') || 'tool',
    schema: descriptor.schema || null,
    executor: typeof descriptor.executor === 'function' ? descriptor.executor : null,
    risk: normalizeText(descriptor.risk || 'low') || 'low',
    readOnly: descriptor.readOnly !== false,
    sideEffect: Boolean(descriptor.sideEffect),
    parallelSafe: descriptor.parallelSafe !== false,
    resumable: descriptor.resumable !== false,
    maxCallsPerTurn: Number.isFinite(Number(descriptor.maxCallsPerTurn))
      ? Math.max(1, Math.floor(Number(descriptor.maxCallsPerTurn)))
      : 1,
    allowedRoutes: normalizeArray(descriptor.allowedRoutes).map((item) => normalizeText(item)).filter(Boolean),
    resultFormatter: typeof descriptor.resultFormatter === 'function' ? descriptor.resultFormatter : null,
    supportsPreflight: Boolean(descriptor.supportsPreflight),
    metadata: normalizeObject(descriptor.metadata, {})
  };
}

module.exports = {
  buildToolEvidenceBundle,
  createCapabilityDescriptor,
  defaultStableHash,
  extractExecLogsFromEnvelopes,
  inferStepKindFromTool,
  normalizeArray,
  normalizeExecutionEnvelope,
  normalizeObject,
  normalizePlanStep,
  normalizeStepId,
  normalizeText,
  stableStringify,
  summarizeToolResultText,
  validatePlannerExecutionPlan
};

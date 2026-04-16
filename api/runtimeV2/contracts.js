function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').trim();
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

function normalizeExecutionEnvelope(rawEnvelope = {}, fallbackStep = {}) {
  const envelope = normalizeObject(rawEnvelope, {});
  const step = normalizeObject(fallbackStep, {});
  const batchId = normalizeText(envelope.batch_id || envelope.batchId || step.batchId || step.batch_id);
  const batchIndexRaw = envelope.batch_index ?? envelope.batchIndex ?? step.batchIndex ?? step.batch_index;
  const batchIndex = Number.isFinite(Number(batchIndexRaw)) ? Number(batchIndexRaw) : null;
  const normalized = {
    tool_call_id: normalizeText(envelope.tool_call_id || envelope.toolCallId),
    step_id: normalizeText(envelope.step_id || envelope.stepId || step.id),
    tool_name: normalizeText(envelope.tool_name || envelope.toolName || step.tool),
    args_hash: normalizeText(envelope.args_hash || envelope.argsHash),
    args: normalizeObject(envelope.args, normalizeObject(step.inputs, {})),
    status: normalizeText(envelope.status || 'failed') || 'failed',
    result: typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope.result ?? ''),
    side_effect: Boolean(envelope.side_effect ?? envelope.sideEffect),
    retryable: envelope.retryable !== false,
    attempt: Number.isFinite(Number(envelope.attempt)) ? Math.max(1, Math.floor(Number(envelope.attempt))) : Math.max(1, Number(step.attempts || 0) + 1),
    reused: Boolean(envelope.reused)
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
  createCapabilityDescriptor,
  inferStepKindFromTool,
  normalizeArray,
  normalizeExecutionEnvelope,
  normalizeObject,
  normalizePlanStep,
  normalizeStepId,
  normalizeText
};

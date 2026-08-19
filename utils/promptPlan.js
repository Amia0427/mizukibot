const {
  KNOWN_STAGES,
  createPromptModulesFromBlocks,
  createPromptRegistry
} = require('./promptManifest');

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function resolveRegistry(context = {}) {
  if (context.registry && Array.isArray(context.registry.modules)) return context.registry;
  const version = normalizeText(
    context.version
    || context.promptSnapshot?.version
    || context.runtimeSnapshot?.version,
    'legacy'
  );
  return createPromptRegistry(createPromptModulesFromBlocks(context.blocks, { version }));
}

function resolveEnabledDecision(module, context) {
  const result = module.enabledWhen(context);
  if (result && typeof result === 'object') {
    return {
      enabled: result.enabled === true,
      reason: normalizeText(result.reason, result.enabled === true ? 'enabled_when_true' : 'enabled_when_false')
    };
  }
  return {
    enabled: result === true,
    reason: result === true ? 'enabled_when_true' : 'enabled_when_false'
  };
}

function resolvePromptPlan(context = {}) {
  const registry = resolveRegistry(context);
  const stage = normalizeText(context.stage, 'main').toLowerCase();
  if (!KNOWN_STAGES.has(stage)) throw new Error(`Unknown prompt stage: ${stage}`);
  const decisions = [];
  const modules = [];

  for (const module of registry.modules) {
    if (module.stage !== 'shared' && module.stage !== stage) {
      decisions.push({ id: module.id, enabled: false, reason: 'stage_mismatch' });
      continue;
    }
    const decision = resolveEnabledDecision(module, context);
    decisions.push({ id: module.id, ...decision });
    if (decision.enabled) modules.push(module);
  }

  return Object.freeze({
    schemaVersion: 'prompt_plan_v1',
    version: registry.version,
    stage,
    policyKey: normalizeText(context.policyKey),
    budgetTokens: Math.max(0, Number(context.budgetTokens || 0) || 0),
    modules: Object.freeze(modules),
    decisions: Object.freeze(decisions),
    registry
  });
}

module.exports = {
  resolvePromptPlan
};

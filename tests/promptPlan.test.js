const assert = require('assert');

const { createPromptRegistry } = require('../utils/promptManifest');
const { resolvePromptPlan } = require('../utils/promptPlan');
const { compilePromptPlan } = require('../utils/promptCompiler');

function moduleDefinition(id, overrides = {}) {
  return {
    id,
    version: '2026-08-17.1',
    stage: 'main',
    tier: 'context',
    priority: 100,
    maxTokens: 0,
    cacheScope: 'dynamic_context',
    enabledWhen: () => true,
    render: () => ({ content: id, estimatedTokens: 4 }),
    ...overrides
  };
}

(() => {
  assert.throws(
    () => createPromptRegistry([
      moduleDefinition('duplicate'),
      moduleDefinition('duplicate')
    ]),
    /Duplicate prompt module id: duplicate/
  );
  assert.throws(
    () => createPromptRegistry([moduleDefinition('bad_stage', { stage: 'unknown' })]),
    /Unknown prompt stage: unknown/
  );
  assert.throws(
    () => createPromptRegistry([moduleDefinition('missing_render', { render: null })]),
    /render/
  );

  const registry = createPromptRegistry([
    moduleDefinition('root', {
      tier: 'core',
      priority: -1000,
      cacheScope: 'stable_system',
      render: () => ({ content: 'root', estimatedTokens: 8 })
    }),
    moduleDefinition('contract', {
      tier: 'contract',
      priority: 5,
      cacheScope: 'stable_system',
      render: () => ({ content: 'contract', estimatedTokens: 8 })
    }),
    moduleDefinition('persona', {
      tier: 'persona',
      priority: 20,
      cacheScope: 'stable_system',
      render: () => ({ content: 'persona', estimatedTokens: 15 })
    }),
    moduleDefinition('context_first', {
      priority: 30,
      render: () => ({ content: 'context first', estimatedTokens: 15 })
    }),
    moduleDefinition('context_second', {
      priority: 30,
      enabledWhen: (context) => context.includeSecond === true,
      render: () => ({ content: 'context second', estimatedTokens: 15 })
    }),
    moduleDefinition('example', {
      tier: 'example',
      priority: 40,
      cacheScope: 'assistant_only',
      render: () => ({ content: 'example', estimatedTokens: 8 })
    })
  ]);

  const context = {
    stage: 'main',
    budgetTokens: 46,
    includeSecond: true,
    policyKey: 'test/main'
  };
  const plan = resolvePromptPlan({ ...context, registry });
  const compiled = compilePromptPlan(plan, context);

  assert.deepStrictEqual(
    compiled.sections.map((section) => section.id),
    ['root', 'contract', 'persona', 'context_first']
  );
  assert.deepStrictEqual(
    compiled.diagnostics.trimmedModules.map((item) => item.id),
    ['example', 'context_second']
  );
  assert.strictEqual(compiled.diagnostics.version, '2026-08-17.1');
  assert.strictEqual(compiled.diagnostics.policyKey, 'test/main');
  assert.deepStrictEqual(compiled.diagnostics.finalOrder, ['root', 'contract', 'persona', 'context_first']);
  assert.ok(compiled.diagnostics.enabledModules.every((item) => item.reason));

  const disabledPlan = resolvePromptPlan({ ...context, includeSecond: false, registry });
  assert.ok(disabledPlan.decisions.some((item) => (
    item.id === 'context_second'
    && item.enabled === false
    && item.reason === 'enabled_when_false'
  )));

  const protectedRegistry = createPromptRegistry([
    moduleDefinition('core', {
      tier: 'core',
      render: () => ({ content: 'core', estimatedTokens: 10 })
    }),
    moduleDefinition('contract', {
      tier: 'contract',
      render: () => ({ content: 'contract', estimatedTokens: 10 })
    }),
    moduleDefinition('tool_protocol', {
      tier: 'capability',
      render: () => ({ content: 'tool protocol', estimatedTokens: 10 })
    })
  ]);
  const protectedContext = { stage: 'main', budgetTokens: 1, registry: protectedRegistry };
  const protectedCompiled = compilePromptPlan(resolvePromptPlan(protectedContext), protectedContext);
  assert.deepStrictEqual(
    protectedCompiled.sections.map((section) => section.id),
    ['core', 'contract', 'tool_protocol']
  );
  assert.strictEqual(protectedCompiled.diagnostics.budget.exceededByProtectedModules, true);

  console.log('promptPlan.test.js passed');
})();

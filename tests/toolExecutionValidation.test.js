const assert = require('assert');

const {
  createToolExecutionHelpers,
  summarizeToolResultForLoop,
  validateToolCallArgs
} = require('../api/runtimeV2/runtime/toolExecution');

module.exports = (async () => {
  const schema = {
    type: 'function',
    function: {
      name: 'lookup',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' }
        },
        required: ['query']
      }
    }
  };

  const missing = validateToolCallArgs('lookup', {}, schema);
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.error.type, 'missing_required');

  const wrongType = validateToolCallArgs('lookup', { query: 123 }, schema);
  assert.strictEqual(wrongType.ok, false);
  assert.strictEqual(wrongType.error.type, 'type_mismatch');

  const valid = validateToolCallArgs('lookup', { query: 'abc', limit: 2 }, schema);
  assert.strictEqual(valid.ok, true);

  let executed = false;
  const helpers = createToolExecutionHelpers({
    config: { TOOL_ARG_VALIDATION_ENABLED: true, READONLY_TOOL_CACHE_TTL_MS: 0, READONLY_TOOL_INFLIGHT_DEDUP_ENABLED: false },
    stableHash: (value) => JSON.stringify(value),
    summarizeToolLogValue: (value) => String(value),
    getPolicy: () => ({}),
    enforceToolPolicy: (_toolName, args) => args,
    shouldRunParallel: () => false,
    capabilityRegistry: { byName: new Map() },
    buildLiveMainConversationSnapshot: () => ({}),
    computeEffectiveAllowedTools: () => ['lookup'],
    createMemoryCliTurnState: (value) => value || {},
    updateMemoryCliTurnStateAfterError: (state) => state,
    updateMemoryCliTurnStateAfterResult: (state) => state,
    decideMemoryCliTurnAction: () => ({ allowed: true }),
    safeParseMemoryCliResult: () => null,
    captureToolFailure: () => {},
    isPlannerSingleAuthorityEnabled: () => false,
    toolExecutors: {
      lookup: async () => {
        executed = true;
        return 'should not run';
      }
    }
  });

  const envelope = await helpers.runToolStep(
    { id: 's1', tool: 'lookup', inputs: {} },
    { request: { allowedTools: ['lookup'] }, execution: {} },
    { getToolSchemaByName: () => schema }
  );
  assert.strictEqual(executed, false);
  assert.strictEqual(envelope.status, 'invalid_args');
  assert.strictEqual(envelope.retryable, true);
  assert.match(envelope.result, /Missing required argument/);

  const longText = 'x'.repeat(5000);
  const summarized = summarizeToolResultForLoop(longText, 1000);
  assert.ok(summarized.length < longText.length);
  assert.match(summarized, /tool result truncated/);

  console.log('toolExecutionValidation.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

const assert = require('assert');

const {
  buildToolEvidenceBundle,
  normalizeExecutionEnvelope,
  normalizeToolStep
} = require('../api/runtimeV2/contracts');

module.exports = (() => {
  const step = normalizeToolStep({
    id: 'agent_step_1',
    action: 'web_search',
    args: { query: 'OpenAI docs' },
    purpose: 'Find official docs'
  }, 'agent', 0);
  assert.strictEqual(step.tool, 'web_search');
  assert.deepStrictEqual(step.inputs, { query: 'OpenAI docs' });

  const envelope = normalizeExecutionEnvelope({
    step_id: 'agent_step_1',
    tool_name: 'web_search',
    status: 'completed',
    result: 'x'.repeat(1400),
    args: { query: 'OpenAI docs' }
  }, step, {
    stableHash: (value) => JSON.stringify(value || {}),
    resultMaxChars: 900,
    nowTs: () => 1000
  });

  assert.ok(envelope.tool_call_id);
  assert.strictEqual(envelope.args_hash, '{"query":"OpenAI docs"}');
  assert.strictEqual(envelope.duration_ms, 0);
  assert.strictEqual(envelope.source, 'dispatch');
  assert.ok(envelope.result.length < 1400);
  assert.match(envelope.result, /tool result truncated/);

  const bundle = buildToolEvidenceBundle({
    execution: { toolResults: [envelope] },
    memory: {}
  }, { resultMaxChars: 900 });

  assert.strictEqual(bundle.execLogs.length, 1);
  assert.strictEqual(bundle.toolMessages.length, 1);
  assert.strictEqual(bundle.toolMessages[0].role, 'tool');
  assert.strictEqual(bundle.assistantToolCallMessage.role, 'assistant');
  assert.strictEqual(bundle.assistantToolCallMessage.tool_calls.length, 1);
  assert.strictEqual(bundle.envelopes.length, 1);

  console.log('toolContractsValidation.test.js passed');
})();

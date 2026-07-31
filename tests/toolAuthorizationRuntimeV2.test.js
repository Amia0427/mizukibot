const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { executeStep } = require('../api/runtimeV2/capabilities/scheduler');
const { buildStaticToolDescriptors } = require('../api/runtimeV2/capabilities/registry');
const { extractExecLogsFromEnvelopes } = require('../api/runtimeV2/contracts');
const { applyRuntimeReplyOutput } = require('../api/runtimeV2/host');
const { createToolExecutionHelpers } = require('../api/runtimeV2/runtime/toolExecution');
const {
  getPolicy,
  hasPublicToolPolicy,
  resolveToolPolicy
} = require('../utils/toolPolicy');

function createState(toolName) {
  return {
    request: {
      userId: 'user-1',
      routeMeta: { chatType: 'group', groupId: 'group-1' },
      allowedTools: [toolName]
    },
    thread: { threadId: 'thread-1' },
    execution: {},
    plan: { steps: [] },
    memory: {}
  };
}

function createStep(id, inputs) {
  return {
    id,
    kind: 'tool',
    tool: 'skill_stock_watchlist',
    inputs,
    status: 'pending',
    evidence: []
  };
}

function createAuthorizationBoundary() {
  let sequence = 0;
  const calls = [];
  return {
    calls,
    async execute(input) {
      calls.push(input);
      if (input.policy.confirmation === 'none') {
        return {
          status: 'completed',
          executed: true,
          result: await input.executor({ ...input.normalizedArgs, __context: input.toolContext })
        };
      }
      sequence += 1;
      const authorization = {
        ticketId: `TA-RUNTIME-${sequence}`,
        status: 'pending',
        toolName: input.toolName,
        confirmation: input.policy.confirmation,
        expiresAt: 999999,
        argsHash: `hash-${sequence}`
      };
      return {
        status: 'confirmation_required',
        executed: false,
        retryable: false,
        result: `Tool authorization required: ${authorization.ticketId}`,
        authorization,
        auditEvent: {
          type: 'tool_authorization_decision',
          authorizationId: authorization.ticketId,
          decision: 'pending_created'
        }
      };
    }
  };
}

function createDirectHelpers(executor, boundary) {
  return createToolExecutionHelpers({
    config: {
      TOOL_ARG_VALIDATION_ENABLED: false,
      READONLY_TOOL_CACHE_TTL_MS: 0,
      READONLY_TOOL_INFLIGHT_DEDUP_ENABLED: false
    },
    stableHash: (value) => JSON.stringify(value || {}),
    summarizeToolLogValue: (value) => String(value),
    getPolicy,
    resolveToolPolicy,
    hasPublicToolPolicy,
    isDynamicToolRegistered: () => false,
    executeAuthorizedToolCall: boundary.execute,
    enforceToolPolicy: (_toolName, args) => args,
    shouldRunParallel: () => false,
    capabilityRegistry: { byName: new Map() },
    buildLiveMainConversationSnapshot: () => null,
    computeEffectiveAllowedTools: (request = {}) => request.allowedTools || [],
    createMemoryCliTurnState: (value = {}) => value,
    updateMemoryCliTurnStateAfterError: (state = {}) => state,
    updateMemoryCliTurnStateAfterResult: (state = {}) => state,
    decideMemoryCliTurnAction: () => ({ ok: true }),
    safeParseMemoryCliResult: () => null,
    captureToolFailure: () => {},
    isPlannerSingleAuthorityEnabled: () => false,
    toolExecutors: { skill_stock_watchlist: executor }
  });
}

module.exports = (async () => {
  let directExecutorCalls = 0;
  const directBoundary = createAuthorizationBoundary();
  const directHelpers = createDirectHelpers(async () => {
    directExecutorCalls += 1;
    return 'direct ok';
  }, directBoundary);

  const directPending = await directHelpers.runToolStep(
    createStep('direct-write', { action: 'add', ticker: 'AAA' }),
    createState('skill_stock_watchlist')
  );
  assert.strictEqual(directPending.status, 'confirmation_required');
  assert.strictEqual(directPending.retryable, false);
  assert.strictEqual(directPending.authorization.ticketId, 'TA-RUNTIME-1');
  assert.strictEqual(directPending.authorizationEvent.type, 'tool_authorization_decision');
  assert.strictEqual(directExecutorCalls, 0);
  assert.strictEqual(directBoundary.calls[0].actor.userId, 'user-1');
  assert.strictEqual(directBoundary.calls[0].actor.chatType, 'group');
  assert.strictEqual(directBoundary.calls[0].actor.groupId, 'group-1');
  assert.match(directBoundary.calls[0].invocationKey, /thread-1.*direct-write/);

  const directRead = await directHelpers.runToolStep(
    createStep('direct-read', { action: 'list' }),
    createState('skill_stock_watchlist')
  );
  assert.strictEqual(directRead.status, 'completed');
  assert.strictEqual(directRead.side_effect, false);
  assert.strictEqual(directExecutorCalls, 1);

  let schedulerExecutorCalls = 0;
  const schedulerBoundary = createAuthorizationBoundary();
  const baseDescriptor = buildStaticToolDescriptors()
    .find((descriptor) => descriptor.name === 'skill_stock_watchlist');
  const descriptor = {
    ...baseDescriptor,
    executor: async () => {
      schedulerExecutorCalls += 1;
      return 'scheduler ok';
    }
  };
  const registry = {
    descriptors: [descriptor],
    byName: new Map([[descriptor.name, descriptor]])
  };
  const schedulerContext = {
    registry,
    executeAuthorizedToolCall: schedulerBoundary.execute,
    helpers: {
      enforceToolPolicy: (_toolName, args) => args
    }
  };

  const schedulerPending = await executeStep(
    createStep('scheduler-write', { action: 'add', ticker: 'AAA' }),
    createState('skill_stock_watchlist'),
    schedulerContext
  );
  assert.strictEqual(schedulerPending.status, 'confirmation_required');
  assert.strictEqual(schedulerPending.retryable, false);
  assert.strictEqual(schedulerPending.authorization.ticketId, 'TA-RUNTIME-1');
  assert.strictEqual(schedulerPending.authorizationEvent.type, 'tool_authorization_decision');
  assert.strictEqual(schedulerExecutorCalls, 0);
  assert.match(schedulerBoundary.calls[0].invocationKey, /thread-1.*scheduler-write/);

  const schedulerRead = await executeStep(
    createStep('scheduler-read', { action: 'list' }),
    createState('skill_stock_watchlist'),
    schedulerContext
  );
  assert.strictEqual(schedulerRead.status, 'completed');
  assert.strictEqual(schedulerRead.side_effect, false);
  assert.strictEqual(schedulerExecutorCalls, 1);

  const logs = extractExecLogsFromEnvelopes([directPending]);
  assert.strictEqual(logs[0].retryable, false);
  assert.strictEqual(logs[0].authorization.ticketId, 'TA-RUNTIME-1');

  const options = {};
  const reply = applyRuntimeReplyOutput({
    output: { finalReply: '需要确认后执行。' },
    execution: { toolResults: [directPending] },
    plan: { steps: [] }
  }, options);
  assert.strictEqual(
    reply,
    '需要确认后执行。\n\n确认执行：/tool-confirm TA-RUNTIME-1\n取消执行：/tool-cancel TA-RUNTIME-1'
  );
  assert.deepStrictEqual(options.pendingToolAuthorizations, [directPending.authorization]);

  console.log('toolAuthorizationRuntimeV2.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

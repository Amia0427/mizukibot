const crypto = require('crypto');
const config = require('../config');
const {
  getDynamicToolNames,
  getRawToolExecutor,
  getToolSchemaByName
} = require('./toolRegistry');
const { validateToolCallArgs } = require('./runtimeV2/runtime/toolExecutionPrimitives');
const { isAdminUserId } = require('../utils/privilegedPrivateChat');
const {
  enforceToolPolicy,
  hasPublicToolPolicy,
  resolveToolPolicy
} = require('../utils/toolPolicy');
const {
  createToolAuthorizationStore,
  hashValue,
  normalizeActor,
  normalizeOriginRoute
} = require('../utils/toolAuthorizationStore');
const { getDeliveryContext, runWithDeliveryContext } = require('../src/platforms/deliveryContext');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function buildRequestKey(input = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    invocationKey: normalizeText(input.invocationKey),
    toolName: normalizeText(input.toolName),
    actor: normalizeActor(input.actor),
    approvalActor: normalizeActor(input.approvalActor || input.actor),
    argsHash: hashValue(normalizeObject(input.rawArgs, {}))
  })).digest('hex');
}

function buildAuditEvent(ticket = {}, decision = '', reason = '') {
  return {
    type: 'tool_authorization_decision',
    authorizationId: normalizeText(ticket.id),
    toolName: normalizeText(ticket.toolName),
    decision: normalizeText(decision),
    reason: normalizeText(reason),
    status: normalizeText(ticket.status),
    confirmation: normalizeText(ticket.confirmation || ticket.policy?.confirmation),
    argsHash: normalizeText(ticket.argsHash),
    ts: Date.now()
  };
}

function publicAuthorization(ticket = {}) {
  let originRoute = null;
  try {
    originRoute = normalizeOriginRoute(ticket.originRoute);
  } catch (_) {}
  return {
    ticketId: normalizeText(ticket.id),
    status: normalizeText(ticket.status),
    toolName: normalizeText(ticket.toolName),
    confirmation: normalizeText(ticket.confirmation || ticket.policy?.confirmation),
    expiresAt: Number(ticket.expiresAt || 0),
    argsHash: normalizeText(ticket.argsHash),
    ...(originRoute ? { originRoute } : {})
  };
}

function denied(reason, ticket = null) {
  const status = normalizeText(ticket?.status);
  return {
    status: 'denied',
    executed: false,
    reason: normalizeText(reason) || 'authorization_denied',
    ...(status ? { ticketStatus: status } : {}),
    ...(ticket ? { authorization: publicAuthorization(ticket) } : {}),
    auditEvent: buildAuditEvent(ticket || {}, 'denied', reason)
  };
}

function samePolicy(left = {}, right = {}) {
  return [
    'version',
    'risk',
    'capability',
    'effect',
    'confirmation',
    'scope',
    'idempotency',
    'replay',
    'exposure'
  ]
    .every((field) => normalizeText(left[field]) === normalizeText(right[field]));
}

function createToolAuthorizationService(options = {}) {
  const store = options.store;
  if (!store) throw new TypeError('tool authorization store is required');
  const isAdminUser = typeof options.isAdminUser === 'function'
    ? options.isAdminUser
    : (userId) => isAdminUserId(userId, options.config || config);
  const publicPolicyExists = options.hasPublicToolPolicy || hasPublicToolPolicy;
  const dynamicToolExists = options.isDynamicToolRegistered
    || ((toolName) => getDynamicToolNames().includes(normalizeText(toolName)));
  const findSchema = options.getToolSchemaByName || getToolSchemaByName;
  const findExecutor = options.getToolExecutor || getRawToolExecutor;
  const resolvePolicy = options.resolveToolPolicy || resolveToolPolicy;
  const normalizePolicyArgs = options.enforceToolPolicy || enforceToolPolicy;
  const validateArgs = options.validateToolCallArgs || validateToolCallArgs;
  const argValidationEnabled = options.toolArgValidationEnabled !== false
    && options.config?.TOOL_ARG_VALIDATION_ENABLED !== false
    && config.TOOL_ARG_VALIDATION_ENABLED !== false;
  const emitDecision = typeof options.emitDecision === 'function' ? options.emitDecision : null;

  function emit(event) {
    if (emitDecision && event) emitDecision(event);
    return event;
  }

  async function executeAuthorizedToolCall(input = {}) {
    const toolName = normalizeText(input.toolName);
    const actor = normalizeActor(input.actor);
    const approvalActor = normalizeActor(input.approvalActor || (
      actor.platform === 'weixin'
        ? { platform: 'qq', userId: actor.userId, chatType: 'private' }
        : actor
    ));
    const policy = normalizeObject(input.policy, {});
    const rawArgs = normalizeObject(input.rawArgs, {});
    const normalizedArgs = normalizeObject(input.normalizedArgs, rawArgs);
    const toolContext = normalizeObject(input.toolContext, {});
    const executor = input.executor;
    if (!toolName || typeof executor !== 'function') return denied('executor_unavailable');

    let originRoute = null;
    try {
      originRoute = normalizeOriginRoute(input.originRoute);
    } catch (_) {
      return denied('invalid_origin_route');
    }
    if (originRoute && originRoute.platform !== actor.platform) return denied('invalid_origin_route');
    if (originRoute?.platform === 'weixin') {
      const deliveryContext = getDeliveryContext();
      let currentTarget = null;
      try {
        currentTarget = normalizeOriginRoute(deliveryContext?.target);
      } catch (_) {}
      if (
        currentTarget?.key !== originRoute.key
        || normalizeText(deliveryContext?.personId) !== actor.userId
      ) {
        return denied('invalid_origin_route');
      }
    }

    const confirmation = normalizeText(policy.confirmation);
    if (confirmation === 'none') {
      const result = await executor({ ...normalizedArgs, __context: toolContext });
      return { status: 'completed', executed: true, result };
    }
    if (!['explicit', 'admin_explicit'].includes(confirmation)) {
      return denied('unsupported_confirmation_policy');
    }
    if (!normalizeText(input.invocationKey)) return denied('missing_invocation_key');
    if (!actor.userId || !['private', 'group'].includes(actor.chatType)) return denied('invalid_actor');
    if (actor.chatType === 'group' && !actor.groupId) return denied('invalid_actor');
    if (!approvalActor.userId || !['private', 'group'].includes(approvalActor.chatType)) {
      return denied('invalid_approval_actor');
    }
    if (approvalActor.chatType === 'group' && !approvalActor.groupId) return denied('invalid_approval_actor');
    if (confirmation === 'admin_explicit' && !isAdminUser(actor.userId)) {
      return denied('admin_required');
    }

    const created = store.createPending({
      requestKey: buildRequestKey({ ...input, toolName, actor, approvalActor, rawArgs }),
      toolName,
      rawArgs,
      toolContext,
      actor,
      approvalActor,
      originRoute,
      policy
    });
    const ticket = created.ticket;
    if (ticket.status !== 'pending') return denied('already_consumed', ticket);
    const auditEvent = emit(buildAuditEvent(
      ticket,
      created.created ? 'pending_created' : 'pending_reused'
    ));
    return {
      status: 'confirmation_required',
      executed: false,
      retryable: false,
      result: `Tool authorization required: ${ticket.id}`,
      authorization: publicAuthorization(ticket),
      auditEvent
    };
  }

  function reject(ticket, reason) {
    store.reject(ticket.id, reason);
    const current = store.getTicket(ticket.id) || ticket;
    const result = denied(reason, current);
    emit(result.auditEvent);
    return result;
  }

  async function confirm(ticketId, rawActor = {}) {
    const actor = normalizeActor(rawActor);
    const inspected = store.getPendingForActor(ticketId, actor);
    if (!inspected.ok) {
      const ticket = store.getTicket(ticketId);
      const result = denied(inspected.reason, ticket);
      emit(result.auditEvent);
      return result;
    }
    const ticket = inspected.ticket;
    let originRoute = null;
    try {
      originRoute = normalizeOriginRoute(ticket.originRoute);
    } catch (_) {
      return reject(ticket, 'invalid_origin_route');
    }
    if (ticket.confirmation === 'admin_explicit' && !isAdminUser(actor.userId)) {
      return reject(ticket, 'admin_required');
    }
    if (
      !normalizeObject(ticket.rawArgs, null)
      || !normalizeObject(ticket.toolContext, null)
      || hashValue(ticket.rawArgs) !== ticket.argsHash
      || hashValue(ticket.toolContext) !== ticket.contextHash
    ) {
      return reject(ticket, 'ticket_integrity_failed');
    }

    const isDynamic = Boolean(dynamicToolExists(ticket.toolName));
    if (!publicPolicyExists(ticket.toolName) && !isDynamic) {
      return reject(ticket, 'unknown_capability');
    }
    const schema = findSchema(ticket.toolName);
    if (!schema) return reject(ticket, 'schema_unavailable');
    if (argValidationEnabled) {
      const validation = validateArgs(ticket.toolName, ticket.rawArgs, schema);
      if (!validation.ok) return reject(ticket, 'invalid_args');
    }

    let normalizedArgs;
    try {
      normalizedArgs = normalizePolicyArgs(ticket.toolName, ticket.rawArgs, {
        ...ticket.toolContext,
        userId: actor.userId
      });
    } catch (_) {
      return reject(ticket, 'policy_validation_failed');
    }
    const currentResolution = resolvePolicy(ticket.toolName, normalizedArgs);
    if (currentResolution?.reason) return reject(ticket, currentResolution.reason);
    const currentPolicy = normalizeObject(currentResolution?.policy, {});
    if (!samePolicy(ticket.policy, currentPolicy)) return reject(ticket, 'policy_changed');
    if (currentPolicy.confirmation === 'admin_explicit' && !isAdminUser(actor.userId)) {
      return reject(ticket, 'admin_required');
    }
    const executor = findExecutor(ticket.toolName);
    if (typeof executor !== 'function') return reject(ticket, 'executor_unavailable');

    const claimed = store.claim(ticket.id, actor);
    if (!claimed.ok) {
      const current = store.getTicket(ticket.id);
      const result = denied(claimed.reason, current);
      emit(result.auditEvent);
      return result;
    }
    emit(buildAuditEvent(claimed.ticket, 'approved'));

    let executorCompleted = false;
    try {
      const execute = () => executor({
        ...normalizeObject(normalizedArgs, {}),
        __context: normalizeObject(claimed.ticket.toolContext, {})
      });
      const result = originRoute
        ? await runWithDeliveryContext({
          target: originRoute,
          personId: claimed.ticket.actor.userId
        }, execute)
        : await execute();
      executorCompleted = true;
      const completed = store.complete(ticket.id, { resultHash: hashValue(result) });
      if (!completed.ok) throw new Error(`authorization completion failed: ${completed.reason}`);
      const auditEvent = emit(buildAuditEvent(completed.ticket, 'completed'));
      return {
        status: 'completed',
        executed: true,
        result,
        authorization: publicAuthorization(completed.ticket),
        auditEvent
      };
    } catch (error) {
      const errorCode = executorCompleted ? 'completion_persistence_failed' : 'executor_failed';
      try {
        store.markUncertain(ticket.id, { errorCode });
      } catch (_) {}
      const current = store.getTicket(ticket.id) || claimed.ticket;
      const auditEvent = emit(buildAuditEvent(current, 'uncertain', errorCode));
      return {
        status: 'uncertain',
        executed: true,
        retryable: false,
        reason: errorCode,
        error: normalizeText(error?.message || error),
        authorization: publicAuthorization(current),
        auditEvent
      };
    }
  }

  async function cancel(ticketId, actor = {}) {
    const result = store.cancel(ticketId, actor, 'user_cancelled');
    if (!result.ok) {
      const ticket = store.getTicket(ticketId);
      const response = denied(result.reason, ticket);
      emit(response.auditEvent);
      return response;
    }
    const auditEvent = emit(buildAuditEvent(result.ticket, 'cancelled', 'user_cancelled'));
    return {
      status: 'cancelled',
      executed: false,
      authorization: publicAuthorization(result.ticket),
      auditEvent
    };
  }

  return {
    cancel,
    confirm,
    executeAuthorizedToolCall
  };
}

let defaultStore = null;
let defaultService = null;

function getDefaultToolAuthorizationService() {
  if (!defaultService) {
    defaultStore = createToolAuthorizationStore({
      file: config.TOOL_AUTHORIZATION_DB_FILE,
      ttlMs: config.TOOL_AUTHORIZATION_TTL_MS
    });
    defaultService = createToolAuthorizationService({ store: defaultStore, config });
  }
  return defaultService;
}

function executeAuthorizedToolCall(input = {}) {
  return getDefaultToolAuthorizationService().executeAuthorizedToolCall(input);
}

function confirmToolAuthorization(ticketId, actor = {}) {
  return getDefaultToolAuthorizationService().confirm(ticketId, actor);
}

function cancelToolAuthorization(ticketId, actor = {}) {
  return getDefaultToolAuthorizationService().cancel(ticketId, actor);
}

function closeToolAuthorizationStore() {
  if (defaultStore) defaultStore.close();
  defaultStore = null;
  defaultService = null;
}

module.exports = {
  buildAuditEvent,
  cancelToolAuthorization,
  closeToolAuthorizationStore,
  confirmToolAuthorization,
  createToolAuthorizationService,
  executeAuthorizedToolCall,
  getDefaultToolAuthorizationService
};

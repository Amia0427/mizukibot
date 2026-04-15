const { prepareMemoryCliCommand } = require('./memoryCli');

function createMemoryCliTurnState(overrides = {}) {
  return {
    searchCount: 0,
    openCount: 0,
    successfulCount: 0,
    mustAnswer: false,
    lastSuccessCommand: '',
    lastResultHadHits: false,
    lastErrorType: 'none',
    ...normalizeMemoryCliTurnState(overrides)
  };
}

function normalizeMemoryCliTurnState(input = {}) {
  const state = input && typeof input === 'object' ? input : {};
  return {
    searchCount: Number.isFinite(Number(state.searchCount)) ? Math.max(0, Math.floor(Number(state.searchCount))) : 0,
    openCount: Number.isFinite(Number(state.openCount)) ? Math.max(0, Math.floor(Number(state.openCount))) : 0,
    successfulCount: Number.isFinite(Number(state.successfulCount)) ? Math.max(0, Math.floor(Number(state.successfulCount))) : 0,
    mustAnswer: Boolean(state.mustAnswer),
    lastSuccessCommand: String(state.lastSuccessCommand || '').trim(),
    lastResultHadHits: Boolean(state.lastResultHadHits),
    lastErrorType: String(state.lastErrorType || 'none').trim() || 'none'
  };
}

function safeParseMemoryCliResult(toolResult = '') {
  const text = String(toolResult || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function buildBlockedMemoryCliResult(commandName, reason, errorType, commandText = '') {
  const normalizedCommandName = String(commandName || 'memory_cli').trim() || 'memory_cli';
  const normalizedReason = String(reason || 'blocked').trim() || 'blocked';
  const normalizedErrorType = String(errorType || 'tool_error').trim() || 'tool_error';
  const normalizedCommandText = String(commandText || '').trim();
  const errorMessage = normalizedErrorType === 'tool_loop_limit'
    ? `memory_cli turn limit reached: ${normalizedReason}`
    : `memory_cli command blocked: ${normalizedReason}`;

  return {
    ok: false,
    blocked: true,
    command: normalizedCommandName,
    commandText: normalizedCommandText,
    errorType: normalizedErrorType,
    reason: normalizedReason,
    error: errorMessage
  };
}

function decideMemoryCliTurnAction(command, turnState = {}) {
  const state = normalizeMemoryCliTurnState(turnState);
  const prepared = prepareMemoryCliCommand(command);
  const parsed = prepared.parsed || null;

  if (!prepared.ok || !parsed) {
    return {
      ok: false,
      parsed,
      preparedCommand: '',
      repairApplied: Boolean(prepared.repairApplied),
      repairStrategy: Array.isArray(prepared.repairStrategy) ? prepared.repairStrategy : [],
      invalidReason: String(prepared.invalidReason || 'invalid_command'),
      blocked: true,
      reason: 'invalid_command',
      errorType: 'tool_error',
      result: {
        ...buildBlockedMemoryCliResult('memory_cli', 'invalid_command', 'tool_error', command),
        rawCommandText: String(prepared.rawCommandText || command || '').trim(),
        normalizedCommandText: String(prepared.normalizedCommandText || '').trim(),
        repairApplied: Boolean(prepared.repairApplied),
        repairStrategy: Array.isArray(prepared.repairStrategy) ? prepared.repairStrategy : [],
        invalidReason: String(prepared.invalidReason || 'invalid_command')
      },
      nextState: {
        ...state,
        mustAnswer: true,
        lastErrorType: 'tool_error'
      }
    };
  }

  const commandName = String(parsed.commandName || '').trim();
  if (state.mustAnswer) {
    return {
      ok: false,
      parsed,
      preparedCommand: prepared.preparedCommand || parsed.raw,
      repairApplied: Boolean(prepared.repairApplied),
      repairStrategy: Array.isArray(prepared.repairStrategy) ? prepared.repairStrategy : [],
      invalidReason: '',
      blocked: true,
      reason: 'must_answer',
      errorType: 'tool_loop_limit',
      result: {
        ...buildBlockedMemoryCliResult(commandName, 'must_answer', 'tool_loop_limit', prepared.preparedCommand || parsed.raw),
        rawCommandText: String(prepared.rawCommandText || parsed.raw || '').trim(),
        normalizedCommandText: String(prepared.normalizedCommandText || parsed.raw || '').trim(),
        repairApplied: Boolean(prepared.repairApplied),
        repairStrategy: Array.isArray(prepared.repairStrategy) ? prepared.repairStrategy : [],
        invalidReason: ''
      },
      nextState: {
        ...state,
        mustAnswer: true,
        lastErrorType: 'tool_loop_limit'
      }
    };
  }

  if (!new Set(['search', 'open']).has(commandName)) {
    return {
      ok: false,
      parsed,
      preparedCommand: prepared.preparedCommand || parsed.raw,
      repairApplied: Boolean(prepared.repairApplied),
      repairStrategy: Array.isArray(prepared.repairStrategy) ? prepared.repairStrategy : [],
      invalidReason: '',
      blocked: true,
      reason: 'command_not_allowed_in_chat',
      errorType: 'tool_error',
      result: {
        ...buildBlockedMemoryCliResult(commandName, 'command_not_allowed_in_chat', 'tool_error', prepared.preparedCommand || parsed.raw),
        rawCommandText: String(prepared.rawCommandText || parsed.raw || '').trim(),
        normalizedCommandText: String(prepared.normalizedCommandText || parsed.raw || '').trim(),
        repairApplied: Boolean(prepared.repairApplied),
        repairStrategy: Array.isArray(prepared.repairStrategy) ? prepared.repairStrategy : [],
        invalidReason: ''
      },
      nextState: {
        ...state,
        mustAnswer: true,
        lastErrorType: 'tool_error'
      }
    };
  }

  if (commandName === 'search' && state.searchCount >= 1) {
    return {
      ok: false,
      parsed,
      preparedCommand: prepared.preparedCommand || parsed.raw,
      repairApplied: Boolean(prepared.repairApplied),
      repairStrategy: Array.isArray(prepared.repairStrategy) ? prepared.repairStrategy : [],
      invalidReason: '',
      blocked: true,
      reason: 'search_limit_reached',
      errorType: 'tool_loop_limit',
      result: {
        ...buildBlockedMemoryCliResult(commandName, 'search_limit_reached', 'tool_loop_limit', prepared.preparedCommand || parsed.raw),
        rawCommandText: String(prepared.rawCommandText || parsed.raw || '').trim(),
        normalizedCommandText: String(prepared.normalizedCommandText || parsed.raw || '').trim(),
        repairApplied: Boolean(prepared.repairApplied),
        repairStrategy: Array.isArray(prepared.repairStrategy) ? prepared.repairStrategy : [],
        invalidReason: ''
      },
      nextState: {
        ...state,
        mustAnswer: true,
        lastErrorType: 'tool_loop_limit'
      }
    };
  }

  if (commandName === 'open' && state.openCount >= 1) {
    return {
      ok: false,
      parsed,
      preparedCommand: prepared.preparedCommand || parsed.raw,
      repairApplied: Boolean(prepared.repairApplied),
      repairStrategy: Array.isArray(prepared.repairStrategy) ? prepared.repairStrategy : [],
      invalidReason: '',
      blocked: true,
      reason: 'open_limit_reached',
      errorType: 'tool_loop_limit',
      result: {
        ...buildBlockedMemoryCliResult(commandName, 'open_limit_reached', 'tool_loop_limit', prepared.preparedCommand || parsed.raw),
        rawCommandText: String(prepared.rawCommandText || parsed.raw || '').trim(),
        normalizedCommandText: String(prepared.normalizedCommandText || parsed.raw || '').trim(),
        repairApplied: Boolean(prepared.repairApplied),
        repairStrategy: Array.isArray(prepared.repairStrategy) ? prepared.repairStrategy : [],
        invalidReason: ''
      },
      nextState: {
        ...state,
        mustAnswer: true,
        lastErrorType: 'tool_loop_limit'
      }
    };
  }

  return {
    ok: true,
    parsed,
    preparedCommand: prepared.preparedCommand || parsed.raw,
    repairApplied: Boolean(prepared.repairApplied),
    repairStrategy: Array.isArray(prepared.repairStrategy) ? prepared.repairStrategy : [],
    invalidReason: '',
    blocked: false,
    reason: 'allowed',
    errorType: 'none',
    result: null,
    nextState: state
  };
}

function updateMemoryCliTurnStateAfterResult(turnState = {}, parsedCommand = null, toolResult = null) {
  const state = normalizeMemoryCliTurnState(turnState);
  const parsed = parsedCommand && typeof parsedCommand === 'object' ? parsedCommand : null;
  const result = toolResult && typeof toolResult === 'object' ? toolResult : safeParseMemoryCliResult(toolResult);
  const commandName = String(parsed?.commandName || result?.command || '').trim();
  if (!commandName) return state;

  const nextState = {
    ...state,
    lastSuccessCommand: commandName,
    lastErrorType: 'none'
  };

  if (commandName === 'search') {
    nextState.searchCount += 1;
    nextState.successfulCount += 1;
    const hitCount = Number(result?.count || result?.results?.length || 0) || 0;
    nextState.lastResultHadHits = hitCount > 0;
    nextState.mustAnswer = hitCount <= 0;
    return nextState;
  }

  if (commandName === 'open') {
    nextState.openCount += 1;
    nextState.successfulCount += 1;
    nextState.lastResultHadHits = Boolean(result?.data);
    nextState.mustAnswer = true;
    return nextState;
  }

  return nextState;
}

function updateMemoryCliTurnStateAfterError(turnState = {}, errorType = 'tool_error') {
  const state = normalizeMemoryCliTurnState(turnState);
  return {
    ...state,
    mustAnswer: true,
    lastErrorType: String(errorType || 'tool_error').trim() || 'tool_error'
  };
}

function shouldForceAnswerAfterMemoryCli(turnState = {}) {
  return normalizeMemoryCliTurnState(turnState).mustAnswer;
}

function filterAllowedToolsForMemoryCliTurn(allowedTools, turnState = {}) {
  const tools = Array.isArray(allowedTools) ? allowedTools.filter(Boolean).map((item) => String(item).trim()).filter(Boolean) : [];
  if (!shouldForceAnswerAfterMemoryCli(turnState)) return tools;
  return tools.filter((toolName) => toolName !== 'memory_cli');
}

function buildMemoryCliFollowupInstruction(turnState = {}) {
  const state = normalizeMemoryCliTurnState(turnState);
  if (state.lastSuccessCommand === 'search' && !state.mustAnswer && state.lastResultHadHits && state.openCount < 1) {
    return [
      '[MemoryCLI Turn]',
      'You already searched memory this turn.',
      'If you truly need the full record, you may call memory_cli only once more with `mem open --ref "..."`.',
      'Otherwise answer the user directly.'
    ].join('\n');
  }

  if (state.successfulCount > 0 || state.mustAnswer) {
    return [
      '[MemoryCLI Turn]',
      'You already have the memory result you can use for this turn.',
      'Do not call memory_cli again. Answer the user directly.'
    ].join('\n');
  }

  return '';
}

function getMemoryCliTurnPromptKey(turnState = {}) {
  const state = normalizeMemoryCliTurnState(turnState);
  return JSON.stringify({
    searchCount: state.searchCount,
    openCount: state.openCount,
    successfulCount: state.successfulCount,
    mustAnswer: state.mustAnswer,
    lastSuccessCommand: state.lastSuccessCommand,
    lastResultHadHits: state.lastResultHadHits,
    lastErrorType: state.lastErrorType
  });
}

module.exports = {
  buildBlockedMemoryCliResult,
  buildMemoryCliFollowupInstruction,
  createMemoryCliTurnState,
  decideMemoryCliTurnAction,
  filterAllowedToolsForMemoryCliTurn,
  getMemoryCliTurnPromptKey,
  normalizeMemoryCliTurnState,
  safeParseMemoryCliResult,
  shouldForceAnswerAfterMemoryCli,
  updateMemoryCliTurnStateAfterError,
  updateMemoryCliTurnStateAfterResult
};

function createHumanizeNode(deps = {}) {
  const normalizeObject = typeof deps.normalizeObject === 'function'
    ? deps.normalizeObject
    : ((value, fallback = {}) => (value && typeof value === 'object' ? value : fallback));
  const createEvent = typeof deps.createEvent === 'function'
    ? deps.createEvent
    : ((type, payload = {}) => ({ type, ...payload }));
  const isReviewMode = typeof deps.isReviewMode === 'function'
    ? deps.isReviewMode
    : (() => false);
  const isReplyFailure = typeof deps.isReplyFailure === 'function'
    ? deps.isReplyFailure
    : (() => false);
  const isHumanizerEnabledImpl = typeof deps.isHumanizerEnabledImpl === 'function'
    ? deps.isHumanizerEnabledImpl
    : (() => false);
  const shouldBypassHumanizerForPolicy = typeof deps.shouldBypassHumanizerForPolicy === 'function'
    ? deps.shouldBypassHumanizerForPolicy
    : (() => false);
  const maybeStreamFinalReply = typeof deps.maybeStreamFinalReply === 'function'
    ? deps.maybeStreamFinalReply
    : (async (_state, text) => text);
  const ensureOutputStream = typeof deps.ensureOutputStream === 'function'
    ? deps.ensureOutputStream
    : ((output) => normalizeObject(output.stream, {}));
  const mirrorStreamingFlags = typeof deps.mirrorStreamingFlags === 'function'
    ? deps.mirrorStreamingFlags
    : ((_output, _text) => ({}));
  const runHumanizerImpl = typeof deps.runHumanizerImpl === 'function'
    ? deps.runHumanizerImpl
    : (async (text) => text);
  const getMaxSegments = typeof deps.getMaxSegments === 'function'
    ? deps.getMaxSegments
    : (() => 3);
  const saveAndEmit = typeof deps.saveAndEmit === 'function'
    ? deps.saveAndEmit
    : ((state) => state);

  return async function humanizeNode(state) {
    const request = normalizeObject(state.request, {});
    const draftReply = String(state.output?.draftReply || '').trim();
    const events = [createEvent('node_start', { node: 'humanize' })];
    const isReviewRoute = isReviewMode(request.reviewMode);
    const shouldSkip = !draftReply
      || isReplyFailure(draftReply, { emptyIsFailure: true })
      || !isHumanizerEnabledImpl()
      || isReviewRoute
      || shouldBypassHumanizerForPolicy(request.routePolicyKey);

    if (shouldSkip) {
      const finalReply = request.streaming
        ? await maybeStreamFinalReply(state, draftReply)
        : draftReply;
      const displayReply = String(state.output?.displayReply || finalReply || '').trim() || finalReply;
      const nextStream = request.streaming && String(finalReply || '').trim()
        ? {
          ...ensureOutputStream(state.output, state.execution?.mode === 'tool_plan' ? 'final_only' : 'direct'),
          ...mirrorStreamingFlags(state.output, finalReply),
          completed: true,
          mode: state.execution?.mode === 'tool_plan' ? 'final_only' : 'direct'
        }
        : ensureOutputStream(state.output, state.execution?.mode === 'tool_plan' ? 'final_only' : 'none');
      const skippedEvents = events.concat([
        createEvent('node_complete', { node: 'humanize' })
      ]);
      return saveAndEmit({
        ...state,
        output: {
          ...state.output,
          finalReply,
          displayReply,
          persistedReplyText: String(finalReply || '').trim(),
          stream: nextStream
        },
        execution: {
          ...state.execution,
          currentNode: 'humanize'
        },
        events: skippedEvents
      }, 'humanize', 'running', skippedEvents);
    }

    const finalReply = await runHumanizerImpl(draftReply, {
      question: request.question,
      dynamicPrompt: [
        state.memory?.dynamicPrompt || '',
        request.routePrompt ? `[RoutePrompt]\n${request.routePrompt}` : ''
      ].filter(Boolean).join('\n\n'),
      stream: request.streaming,
      onDelta: request.onDelta,
      streamHadOutput: Boolean(state.output?.stream?.hadOutput),
      maxSegments: getMaxSegments()
    });
    const nextStream = request.streaming
      ? {
        ...ensureOutputStream(state.output, 'final_only'),
        ...mirrorStreamingFlags(state.output, finalReply),
        completed: Boolean(String(finalReply || '').trim()),
        mode: 'final_only'
      }
      : ensureOutputStream(state.output, 'none');

    const nextEvents = events.concat([
      createEvent('model_reply', {
        node: 'humanize',
        preview: String(finalReply || '').slice(0, 180)
      }),
      createEvent('node_complete', { node: 'humanize' })
    ]);
    return saveAndEmit({
      ...state,
      output: {
        ...state.output,
        finalReply: String(finalReply || ''),
        displayReply: String(finalReply || ''),
        persistedReplyText: String(finalReply || ''),
        stream: nextStream
      },
      execution: {
        ...state.execution,
        currentNode: 'humanize'
      },
      events: nextEvents
    }, 'humanize', 'running', nextEvents);
  };
}

module.exports = {
  createHumanizeNode
};

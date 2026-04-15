function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' ? value : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function createContinuityProbeHelpers(deps = {}) {
  const {
    config,
    createEvent,
    buildContinuityState,
    chatHistory,
    shortTermMemory,
    computeEffectiveAllowedTools,
    classifyRecallFacet,
    runToolStep,
    safeParseMemoryCliResult,
    shouldBiasToContinuity,
    shouldPrioritizeMemoryProbe
  } = deps;

  function isReviewMode(reviewMode = '') {
    return Boolean(String(reviewMode || '').trim());
  }

  function isContinuityProbeEligible(request = {}, mode = '') {
    const routeMeta = normalizeObject(request.routeMeta, {});
    const topRouteType = String(request.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
    const routePolicyKey = String(request.routePolicyKey || '').trim().toLowerCase();
    const normalizedMode = String(mode || '').trim().toLowerCase();
    const question = String(request.question || '').trim();
    const facet = classifyRecallFacet(question);
    const explicitContinuityCue = /(where did we leave off|what were we(?: just)? talking about|what were we doing|before|earlier|last time|continue|resume|pick back up|next step|next steps|上次|刚才|之前|继续|接着|做到哪|聊到哪)/i.test(question);
    if (!config.CONTINUITY_AUTO_PROBE_ENABLED) return false;
    if (request.systemInitiated) return false;
    if (String(request.customPrompt || '').trim()) return false;
    if (request.imageUrl) return false;
    if (isReviewMode(request.reviewMode)) return false;
    if (!String(request.userId || '').trim() || !question) return false;
    if (!new Set(['chat', 'tool_plan']).has(normalizedMode)) return false;
    if (topRouteType === 'admin' || topRouteType === 'ignore' || topRouteType === 'refuse') return false;
    if (topRouteType === 'vision' || routePolicyKey.startsWith('vision/')) return false;
    if (!explicitContinuityCue && facet !== 'task_or_plan' && facet !== 'recent_continuity') return false;

    return shouldPrioritizeMemoryProbe({
      rawText: question,
      cleanText: question,
      facets: routeMeta.facets,
      intent: routeMeta.intent,
      meta: routeMeta.meta
    });
  }

  function buildAutoContinuityProbeCommand(question = '') {
    const facet = classifyRecallFacet(question);
    const maxResults = Math.max(1, Math.min(8, Number(config.CONTINUITY_AUTO_PROBE_MAX_RESULTS) || 4));
    if (facet === 'recent_continuity' || facet === 'default_continuity') {
      return {
        facet,
        command: `mem search --query ${JSON.stringify('where did we leave off')} --source recent --limit ${maxResults}`
      };
    }
    if (facet === 'task_or_plan') {
      return {
        facet,
        command: `mem search --query ${JSON.stringify(String(question || '').trim())} --source all --limit ${Math.max(6, maxResults)}`
      };
    }
    return { facet, command: '' };
  }

  async function maybeRunAutoContinuityProbe(state, runtimeOptions = {}) {
    const request = normalizeObject(state.request, {});
    const mode = String(state.execution?.mode || runtimeOptions.normalizeMode?.(request)).trim().toLowerCase();
    if (request.allowTools === false) {
      return {
        skipped: true,
        reason: 'tools_disabled',
        probeResult: null,
        probeMeta: null,
        events: [createEvent('continuity_probe_skipped', { node: 'prepare', reason: 'tools_disabled', mode })]
      };
    }
    if (!isContinuityProbeEligible(request, mode)) {
      return {
        skipped: true,
        reason: 'route_not_eligible',
        probeResult: null,
        probeMeta: null,
        events: [createEvent('continuity_probe_skipped', { node: 'prepare', reason: 'route_not_eligible', mode })]
      };
    }

    const seeded = buildContinuityState({
      request,
      thread: state.thread,
      shortTermMemory,
      chatHistory,
      maxChars: config.CONTINUITY_STATE_PROMPT_MAX_CHARS
    });
    if (seeded.hasSufficientEvidence) {
      return {
        skipped: true,
        reason: 'local_evidence_sufficient',
        probeResult: null,
        probeMeta: null,
        events: [createEvent('continuity_probe_skipped', { node: 'prepare', reason: 'local_evidence_sufficient', mode })]
      };
    }

    const allowedTools = computeEffectiveAllowedTools(request, state.execution?.memoryCliTurn);
    if (!normalizeArray(allowedTools).includes('memory_cli')) {
      return {
        skipped: true,
        reason: 'memory_cli_unavailable',
        probeResult: null,
        probeMeta: null,
        events: [createEvent('continuity_probe_skipped', { node: 'prepare', reason: 'memory_cli_unavailable', mode })]
      };
    }

    const probeMeta = buildAutoContinuityProbeCommand(request.question || '');
    if (!probeMeta.command || !shouldBiasToContinuity(probeMeta.facet)) {
      return {
        skipped: true,
        reason: 'facet_not_supported',
        probeResult: null,
        probeMeta,
        events: [createEvent('continuity_probe_skipped', { node: 'prepare', reason: 'facet_not_supported', facet: probeMeta.facet, mode })]
      };
    }

    const probeStep = {
      id: `continuity_probe_${Date.now()}`,
      kind: 'memory_cli',
      tool: 'memory_cli',
      instruction: 'read-only continuity probe before reply generation',
      inputs: { command: probeMeta.command },
      successCriteria: 'continuity digest available',
      attempts: 0,
      evidence: [],
      blockingReason: ''
    };
    const startEvents = [
      createEvent('continuity_probe_triggered', {
        node: 'prepare',
        facet: probeMeta.facet,
        mode,
        command: probeMeta.command
      })
    ];

    try {
      const envelope = await runToolStep(probeStep, state, runtimeOptions);
      const parsed = safeParseMemoryCliResult(envelope?.result);
      return {
        skipped: false,
        reason: String(envelope?.status || '').trim() === 'completed' ? 'completed' : 'failed',
        probeResult: String(envelope?.status || '').trim() === 'completed' ? parsed : null,
        probeMeta,
        events: startEvents.concat([
          createEvent('continuity_probe_result', {
            node: 'prepare',
            facet: probeMeta.facet,
            ok: String(envelope?.status || '').trim() === 'completed',
            resultCount: Number(parsed?.count || normalizeArray(parsed?.results).length || 0) || 0
          })
        ])
      };
    } catch (error) {
      return {
        skipped: false,
        reason: 'error',
        probeResult: null,
        probeMeta,
        events: startEvents.concat([
          createEvent('continuity_probe_result', {
            node: 'prepare',
            facet: probeMeta.facet,
            ok: false,
            error: String(error?.message || error).slice(0, 180)
          })
        ])
      };
    }
  }

  return {
    buildAutoContinuityProbeCommand,
    isContinuityProbeEligible,
    maybeRunAutoContinuityProbe
  };
}

module.exports = {
  createContinuityProbeHelpers
};

function createShortTermContinuityDeltaHelpers(deps = {}) {
  const {
    buildStructuredSummaryText,
    config,
    normalizeConfidence,
    normalizeExpressionState,
    normalizeInteractionState,
    normalizeModuleState,
    normalizeRecentTurns,
    normalizeSceneState,
    normalizeShortTermState
  } = deps;

  function deriveShortTermSummaryFromContinuity(state = {}) {
    const normalized = normalizeShortTermState(state);
    return buildStructuredSummaryText({
      summary: normalized.summary,
      activeTopic: normalized.interaction.activeTopic || normalized.activeTopic,
      openLoops: normalized.interaction.openLoops.length > 0 ? normalized.interaction.openLoops : normalized.openLoops,
      assistantCommitments: normalized.interaction.assistantCommitments.length > 0 ? normalized.interaction.assistantCommitments : normalized.assistantCommitments,
      userConstraints: normalized.interaction.userConstraints.length > 0 ? normalized.interaction.userConstraints : normalized.userConstraints,
      recentToolResults: normalized.recentToolResults,
      carryOverUserTurn: normalized.interaction.carryOverUserTurn || normalized.carryOverUserTurn
    }, Math.max(96, Number(config.SHORT_TERM_MEMORY_SUMMARY_MAX_TOKENS || 320)));
  }

  function deriveShortTermFieldsFromContinuity(state = {}) {
    const normalized = normalizeShortTermState(state);
    return {
      activeTopic: normalized.interaction.activeTopic || normalized.activeTopic,
      carryOverUserTurn: normalized.interaction.carryOverUserTurn || normalized.carryOverUserTurn,
      openLoops: normalized.interaction.openLoops.length > 0 ? normalized.interaction.openLoops : normalized.openLoops,
      assistantCommitments: normalized.interaction.assistantCommitments.length > 0 ? normalized.interaction.assistantCommitments : normalized.assistantCommitments,
      userConstraints: normalized.interaction.userConstraints.length > 0 ? normalized.interaction.userConstraints : normalized.userConstraints,
      phaseHint: normalized.interaction.phaseHint || normalized.phaseHint,
      sceneRef: normalized.scene.sceneKey || normalized.sceneRef,
      confidence: normalized.confidence,
      summary: normalized.summary || deriveShortTermSummaryFromContinuity(normalized),
      summarySource: normalized.summarySource || (normalized.summary ? 'continuity' : '')
    };
  }

  function applyPersonaContinuityDelta(targetState = {}, delta = {}) {
    const current = normalizeShortTermState(targetState);
    const patch = delta && typeof delta === 'object' ? delta : {};
    const nextInteraction = normalizeInteractionState({
      ...current.interaction,
      ...(patch.interaction && typeof patch.interaction === 'object' ? patch.interaction : {}),
      activeTopic: patch.activeTopic || patch.interaction?.activeTopic || current.interaction.activeTopic,
      carryOverUserTurn: patch.carryOverUserTurn || patch.interaction?.carryOverUserTurn || current.interaction.carryOverUserTurn,
      openLoops: patch.openLoops || patch.interaction?.openLoops || current.interaction.openLoops,
      assistantCommitments: patch.assistantCommitments || patch.interaction?.assistantCommitments || current.interaction.assistantCommitments,
      userConstraints: patch.userConstraints || patch.interaction?.userConstraints || current.interaction.userConstraints,
      recentTurns: patch.recentTurns || patch.interaction?.recentTurns || current.interaction.recentTurns,
      phaseHint: patch.phaseHint || patch.interaction?.phaseHint || current.interaction.phaseHint,
      sourceFlags: patch.sourceFlags || patch.interaction?.sourceFlags || current.interaction.sourceFlags,
      confidence: patch.confidence ?? patch.interaction?.confidence ?? current.interaction.confidence
    });
    const nextScene = normalizeSceneState({
      ...current.scene,
      ...(patch.scene && typeof patch.scene === 'object' ? patch.scene : {}),
      sceneKey: patch.sceneRef || patch.sceneKey || patch.scene?.sceneKey || current.scene.sceneKey,
      activeTopic: patch.scene?.activeTopic || current.scene.activeTopic,
      recentTurns: patch.scene?.recentTurns || current.scene.recentTurns,
      confidence: patch.scene?.confidence ?? current.scene.confidence
    });
    const nextExpression = normalizeExpressionState({
      ...current.expression,
      ...(patch.expression && typeof patch.expression === 'object' ? patch.expression : {}),
      replyPosture: patch.replyPosture || patch.expression?.replyPosture || current.expression.replyPosture,
      warmth: patch.warmth || patch.expression?.warmth || current.expression.warmth,
      guardedness: patch.guardedness || patch.expression?.guardedness || current.expression.guardedness,
      initiative: patch.initiative || patch.expression?.initiative || current.expression.initiative,
      jargonMode: patch.jargonMode || patch.expression?.jargonMode || current.expression.jargonMode,
      cadenceHint: patch.cadenceHint || patch.expression?.cadenceHint || current.expression.cadenceHint,
      styleAnchors: patch.styleAnchors || patch.expression?.styleAnchors || current.expression.styleAnchors,
      confidence: patch.expression?.confidence ?? current.expression.confidence
    });
    const nextModuleState = normalizeModuleState({
      ...current.moduleState,
      ...(patch.moduleState && typeof patch.moduleState === 'object' ? patch.moduleState : {}),
      activePersonaModules: patch.activePersonaModules || patch.moduleState?.activePersonaModules || current.moduleState.activePersonaModules,
      switchReason: patch.switchReason || patch.moduleState?.switchReason || current.moduleState.switchReason
    });

    const next = normalizeShortTermState({
      ...current,
      ...patch,
      interaction: nextInteraction,
      scene: nextScene,
      expression: nextExpression,
      moduleState: nextModuleState,
      phaseHint: nextInteraction.phaseHint || current.phaseHint,
      sceneRef: nextScene.sceneKey || current.sceneRef,
      confidence: Math.max(
        normalizeConfidence(patch.confidence, current.confidence),
        nextInteraction.confidence,
        nextExpression.confidence,
        nextScene.confidence
      )
    });
    const derived = deriveShortTermFieldsFromContinuity(next);
    return normalizeShortTermState({
      ...next,
      ...derived
    });
  }

  return {
    applyPersonaContinuityDelta,
    deriveShortTermFieldsFromContinuity,
    deriveShortTermSummaryFromContinuity
  };
}

module.exports = {
  createShortTermContinuityDeltaHelpers
};

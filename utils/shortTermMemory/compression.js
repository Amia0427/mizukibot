function createShortTermCompressionHelpers(deps = {}) {
  const {
    config,
    defaultShortTermState,
    ensureShortTermMemoryState,
    estimateMessagesTokens,
    getCompressionChunkMaxMessages,
    getShortTermCompressionSettings,
    normalizeMessageContent,
    normalizeShortTermState,
    resolveShortTermSessionKey,
    trimTextByTokenBudget,
    applyPersonaContinuityDelta
  } = deps;

  function serializeHistoryChunk(messages = []) {
    return (Array.isArray(messages) ? messages : [])
      .map((item) => {
        const role = String(item?.role || '').trim().toLowerCase() === 'assistant' ? 'Assistant' : 'User';
        const content = trimTextByTokenBudget(normalizeMessageContent(item?.content), 220, 'tail');
        return `${role}: ${content || '[empty]'}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  function mergeCompressedSummary(previousSummary, chunkSummary, summaryTokens) {
    const older = trimTextByTokenBudget(String(previousSummary || '').trim(), Math.floor(summaryTokens * 0.45), 'tail');
    const newer = trimTextByTokenBudget(String(chunkSummary || '').trim(), Math.floor(summaryTokens * 0.55), 'tail');

    if (older && newer) {
      return trimTextByTokenBudget(`[Earlier]\n${older}\n\n[Added]\n${newer}`, summaryTokens, 'tail');
    }

    return trimTextByTokenBudget(older || newer, summaryTokens, 'tail');
  }

  function getCompressionCandidateChunk(history = [], reserveRecentMessages = 2) {
    const list = Array.isArray(history) ? history : [];
    const reserve = Math.max(2, Number(reserveRecentMessages) || 2);
    const chunkEnd = Math.max(0, list.length - reserve);
    if (chunkEnd < 4) return [];

    const maxChunk = Math.max(4, Math.min(getCompressionChunkMaxMessages(), chunkEnd));
    const chunk = list.slice(0, maxChunk);
    return chunk.length >= 4 ? chunk : [];
  }

  function stripMarkdownFence(text = '') {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    return fenced ? String(fenced[1] || '').trim() : raw;
  }

  function parseStructuredCompressionOutput(output = '') {
    const raw = stripMarkdownFence(output);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const allowedKeys = new Set([
        'summary',
        'activeTopic',
        'openLoops',
        'assistantCommitments',
        'userConstraints',
        'recentToolResults',
        'carryOverUserTurn',
        'interaction',
        'scene',
        'expression',
        'moduleState',
        'phaseHint',
        'sceneRef',
        'confidence'
      ]);
      const hasKnownKey = Object.keys(parsed).some((key) => allowedKeys.has(key));
      if (!hasKnownKey) return null;
      if ('summary' in parsed && typeof parsed.summary !== 'string') return null;
      for (const key of ['openLoops', 'assistantCommitments', 'userConstraints', 'recentToolResults']) {
        if (key in parsed && !Array.isArray(parsed[key])) return null;
      }
      if ('confidence' in parsed) {
        const confidence = Number(parsed.confidence);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
      }
      return applyPersonaContinuityDelta(defaultShortTermState(), parsed);
    } catch (_) {
      return null;
    }
  }

  function mergeStructuredState(currentState, nextState, summaryTokens) {
    const current = normalizeShortTermState(currentState);
    const next = applyPersonaContinuityDelta(current, nextState);
    return normalizeShortTermState({
      ...current,
      ...next,
      summary: mergeCompressedSummary(current.summary, next.summary, summaryTokens),
      lastCompressedAt: Date.now(),
      rounds: Number(current.rounds || 0)
    });
  }

  async function compressShortTermHistoryIfNeeded(userId, userInfo = {}, deps = {}) {
    const key = String(deps.sessionKey || resolveShortTermSessionKey(userId, deps.routeMeta) || '').trim();
    const historyStore = deps.chatHistory || {};
    if (!historyStore[key]) historyStore[key] = [];

    const history = historyStore[key];
    const settings = getShortTermCompressionSettings(userInfo, { userId: String(userId || '').trim() });
    const state = ensureShortTermMemoryState(key, deps.shortTermMemory);
    const summarizeChunk = typeof deps.summarizeChunk === 'function' ? deps.summarizeChunk : null;
    if (!summarizeChunk) return { compressed: false, summary: state.summary, history, state };

    let compressed = false;
    let rounds = 0;

    while (
      history.length > settings.reserveRecentMessages + 2 &&
      estimateMessagesTokens(history) > settings.triggerTokens &&
      rounds < settings.maxCompressionRounds
    ) {
      const chunk = getCompressionCandidateChunk(history, settings.reserveRecentMessages);
      if (chunk.length < 4) break;

      const chunkText = serializeHistoryChunk(chunk);
      if (!chunkText) break;

      const chunkSummary = await summarizeChunk({
        userId: String(userId || '').trim(),
        sessionKey: key,
        userInfo,
        existingSummary: state.summary,
        existingState: normalizeShortTermState(state),
        chunkMessages: chunk,
        chunkText,
        summaryTokens: settings.summaryMaxTokens
      });

      const normalizedOutput = String(chunkSummary || '').trim();
      if (!normalizedOutput) break;

      const structured = parseStructuredCompressionOutput(normalizedOutput);
      if (structured) {
        const merged = mergeStructuredState(state, structured, settings.summaryMaxTokens);
        Object.assign(state, merged);
        state.summarySource = 'compression';
      } else {
        const normalizedSummary = trimTextByTokenBudget(normalizedOutput, settings.summaryMaxTokens, 'tail');
        if (!normalizedSummary) break;
        state.summary = mergeCompressedSummary(state.summary, normalizedSummary, settings.summaryMaxTokens);
        state.summarySource = 'compression';
        state.lastCompressedAt = Date.now();
      }

      state.rounds += 1;
      history.splice(0, chunk.length);
      compressed = true;
      rounds += 1;
    }

    return {
      compressed,
      summary: state.summary,
      history,
      state: normalizeShortTermState(state)
    };
  }

  function buildStructuredCompressionPrompt(existingState, summaryTokens) {
    const state = normalizeShortTermState(existingState);
    const compactState = {
      summary: state.summary,
      activeTopic: state.activeTopic,
      openLoops: state.openLoops,
      assistantCommitments: state.assistantCommitments,
      userConstraints: state.userConstraints,
      recentToolResults: state.recentToolResults,
      carryOverUserTurn: state.carryOverUserTurn,
      interaction: state.interaction,
      scene: state.scene,
      expression: state.expression,
      moduleState: state.moduleState,
      phaseHint: state.phaseHint,
      sceneRef: state.sceneRef,
      confidence: state.confidence
    };
    return [
      '你是对话短期上下文压缩器。',
      '优先保留：用户约束、助手承诺、未完成事项、最近工具结论、最近主线话题、当前回复姿态、当前场景气氛、persona modules。',
      '返回严格 JSON，不要解释，不要 markdown。',
      '字段固定：summary, activeTopic, openLoops, assistantCommitments, userConstraints, recentToolResults, carryOverUserTurn, interaction, scene, expression, moduleState, phaseHint, sceneRef, confidence。',
      'expression.replyPosture 只能是 light, playful, gentle, reserved, focused, comforting 之一。',
      'styleAnchors 只保留 2 到 4 条短语级锚点。',
      '一次偶发玩笑或角色扮演不要直接写成稳定表达态，除非多轮稳定或有显式反馈。',
      `summary 控制在约 ${summaryTokens} tokens 内。`,
      'openLoops / assistantCommitments / userConstraints 最多 4 条，recentToolResults 最多 3 条。',
      `已有结构化状态：${JSON.stringify(compactState)}`
    ].join('\n');
  }

  return {
    buildStructuredCompressionPrompt,
    compressShortTermHistoryIfNeeded,
    parseStructuredCompressionOutput
  };
}

module.exports = {
  createShortTermCompressionHelpers
};

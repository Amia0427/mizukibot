function createDailyShareEngine({
  knowledgeProvider = dailyShareKnowledgeProvider,
  contentBuilder = null,
  qzonePublisher = null,
  runMemoryCli = null,
  recordMemoryScope = defaultRecordMemoryScope,
  memoryQueryPlanner = null
} = {}) {
  const resolvedContentBuilder = contentBuilder || createDailyShareContent({ knowledgeProvider });
  let targetsCache = null;
  let stateCache = null;

  function getToday(date = new Date()) {
    return formatDateInTz(date, config.TIMEZONE);
  }

  function ensureCaches(today = getToday()) {
    targetsCache = targetsCache || loadTargets();
    stateCache = stateCache || loadState(today);
    return { targets: targetsCache, state: stateCache };
  }

  function flush() {
    if (targetsCache) saveTargets(targetsCache);
    if (stateCache) saveState(stateCache);
  }

  function ensureTargetState(targetId, today = getToday()) {
    const { targets, state } = ensureCaches(today);
    return {
      target: ensureTarget(targets, targetId),
      stateEntry: ensureStateEntry(state, targetId, today)
    };
  }

  function ensureGroup(groupId, today = getToday()) {
    return ensureTargetState(groupId, today);
  }

  function ensureQzone(today = getToday()) {
    return ensureTargetState(QZONE_TARGET_ID, today);
  }

  function formatStatusForTarget(targetId, today = getToday(), date = new Date()) {
    const { target, stateEntry } = ensureTargetState(targetId, today);
    const currentWindow = findCurrentWindow(target, date);
    const windows = getWindowDefinitions(target);
    windows.forEach((windowDef) => ensureWindowSchedule(stateEntry, targetId, windowDef, today, date, target));
    const nextWindow = getNextWindowInfo(target, stateEntry, date);
    const title = String(target?.surface || '').trim().toLowerCase() === 'qzone' ? 'QZone Daily Share' : 'Daily Share';

    const lines = [
      `${title}: ${target.enabled ? '已启用' : '已禁用'}`,
      `今日自动发送：${stateEntry.dailyCount}/${target.maxPerDay}`,
      currentWindow
        ? `当前自动窗口：${currentWindow.label} ${formatWindowRange(currentWindow)}`
        : '当前自动窗口：当前无激活窗口',
      `下一次待执行：${nextWindow.label} ${nextWindow.time}`
    ];

    for (const windowDef of windows) {
      const schedule = stateEntry.scheduleByWindow[windowDef.key];
      const status = stateEntry.windowStatus[windowDef.key];
      const type = getAutoTypeForWindow(target, stateEntry, windowDef.key) || '无';
      lines.push(
        `${windowDef.label} ${formatWindowRange(windowDef)} | ${WINDOW_STATUS_LABELS[status.status] || status.status} | 自动类型 ${type} | 已发 ${Math.max(0, Number(schedule.sentCount || 0) || 0)}/${MAX_AUTO_SENDS_PER_WINDOW} | 计划 ${formatHm(schedule.plannedAt)} | 延期 ${formatHm(schedule.deferredAt)} | 最近成功 ${status.lastSuccessType || '无'} | 最近原因 ${status.lastReason || '无'}`
      );
    }
    return lines.join('\n');
  }

  function formatStatus(groupId, today = getToday(), date = new Date()) {
    return formatStatusForTarget(groupId, today, date);
  }

  async function generateValidatedShare({
    askAIByGraph,
    targetId,
    groupId,
    windowKey,
    type,
    payload,
    stateEntry,
    now,
    surface = 'group'
  }) {
    const normalizedSurface = String(surface || 'group').trim().toLowerCase() || 'group';
    const userId = normalizedSurface === 'qzone' ? 'dailyshare:qzone' : `dailyshare:group:${groupId}`;
    const userInfo = buildDailyShareUserInfo(
      normalizedSurface === 'qzone' ? '' : groupId,
      {
        userId,
        level: normalizedSurface === 'qzone' ? 'self' : 'group',
        relationship: normalizedSurface === 'qzone' ? 'self' : 'group',
        surface: normalizedSurface
      }
    );
    let lastFailure = '';
    let lastFailureClass = '';
    let qzoneMemoryEvidence = { items: [], sources: [] };
    let qzoneMemoryMeta = {
      memoryOwner: '',
      memoryQuery: '',
      memorySearchCount: 0,
      memoryOpenUsed: false,
      memoryOpenedSource: '',
      memoryPrefetchError: '',
      memoryEvidenceSources: []
    };

    if (normalizedSurface === 'qzone') {
      const prefetched = await prefetchQzoneDailyShareMemory({
        type,
        groupId,
        windowKey,
        windowLabel: payload?.windowLabel || windowKey,
        today: formatDateInTz(new Date(now), config.TIMEZONE),
        stateEntry,
        recentShareSummaries: summarizeRecentShares(stateEntry, 3),
        topicLabel: payload?.topicLabel || '',
        payload,
        runMemoryCli,
        recordMemoryScope,
        memoryQueryPlanner
      });
      qzoneMemoryEvidence = prefetched.memoryEvidence || qzoneMemoryEvidence;
      qzoneMemoryMeta = prefetched.meta || qzoneMemoryMeta;
      const memoryBlock = buildQzoneMemoryPromptBlock(qzoneMemoryEvidence);
      if (memoryBlock) {
        payload.prompt = payload.prompt ? `${payload.prompt}\n\n${memoryBlock}` : memoryBlock;
      }
    }

    const recentQzoneHistory = normalizedSurface === 'qzone' ? getRecentQzoneHistory() : [];
    const recentFailureHistory = normalizedSurface === 'qzone' ? getRecentFailureLikeEntries() : [];

    if (normalizedSurface === 'qzone') {
      for (let planAttempt = 0; planAttempt < PLAN_RETRY_LIMIT; planAttempt += 1) {
        const plan = buildQzonePlan({
          source: 'daily_share',
          type,
          windowKey,
          groupId: targetId,
          today: stateEntry?.today || '',
          planAttempt,
          now,
          recentHistory: recentQzoneHistory,
          recentFailures: recentFailureHistory,
          allowImage: false,
          targetLength: type === 'greeting' ? '18-60' : (type === 'mood' ? '24-90' : '30-100')
        });
        const candidates = [];
        for (let candidateIndex = 0; candidateIndex < Math.max(1, CANDIDATE_COUNT); candidateIndex += 1) {
          const variantType = CANDIDATE_VARIANT_TYPES[candidateIndex] || CANDIDATE_VARIANT_TYPES[0];
          const prompt = buildCandidatePrompt(
            buildQzoneDailySharePromptFromPlan({
              payload,
              plan,
              memoryBlock: payload.prompt && payload.prompt.includes('[记忆证据块]') ? '' : payload.prompt,
              retryNote: candidateIndex > 0
                ? `这是第 ${candidateIndex + 1} 个候选，请明显拉开开头、叙事动势和收尾。`
                : ''
            }),
            plan,
            [
              buildDailyShareVariantNote(variantType),
              candidateIndex > 0 ? `上一个候选不够好，请重新组织语气和画面。` : ''
            ].filter(Boolean).join('\n')
          );
          const reply = await askAIByGraph(prompt, userInfo, userId, prompt, null, {
            systemInitiated: true,
            topRouteType: 'proactive',
            routePolicyKey: 'proactive/daily-share',
            disableTools: true,
            disableStream: true,
            disableMemoryLearning: true,
            modelConfig: getModelConfigForQzoneAttempt(candidateIndex > 0 ? 'similarity' : ''),
            routeMeta: {
              groupId: String(groupId || ''),
              taskType: 'daily_share',
              channelId: String(targetId),
              windowKey,
              shareType: type,
              surface: normalizedSurface
            }
          });
          const text = trimReplyText(reply, 260);
          const terminalFailureType = detectQzoneTerminalReplyFailureType(text);
          if (terminalFailureType) {
            throw createDailyShareAbortError(text, terminalFailureType);
          }
          const validation = validateDailyShareOutput(text, type, normalizedSurface);
          candidates.push({
            plan,
            variantType,
            text,
            rejected: !validation.ok,
            rejectionReason: validation.ok ? '' : validation.reason
          });
        }
        const picked = pickBestCandidate(candidates, {
          source: type,
          recentHistory: recentQzoneHistory,
          plan
        });
        if (picked.selected) {
          appendQzoneGenerationLog(normalizeTelemetryPayload({
            source: 'daily_share',
            type,
            groupId: targetId,
            status: 'sent',
            selectedFingerprint: picked.selected.fingerprint,
            selectedScore: picked.selected.score,
            similarity: picked.selected.similarity,
            noveltyScore: picked.selected.noveltyScore,
            tropeCollisionScore: picked.selected.tropeCollisionScore,
            circleNaturalnessScore: picked.selected.circleNaturalnessScore,
            edgeTensionScore: picked.selected.edgeTensionScore,
            failureReasons: [],
            planSummary: {
              fingerprint: plan.fingerprint,
              topicKey: plan.theme?.key || payload.topicKey || '',
              topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : (payload.topicGroup || ''),
              lens: plan.variationProfile?.lens || '',
              anchor: plan.variationProfile?.anchor || '',
              structure: plan.variationProfile?.structure || '',
              arc: plan.variationProfile?.arc || '',
              tempo: plan.variationProfile?.tempo || '',
              distance: plan.variationProfile?.distance || '',
              spark: plan.variationProfile?.spark || '',
              socialMask: plan.variationProfile?.socialMask || '',
              freshnessMode: plan.variationProfile?.freshnessMode || '',
              voiceEdge: plan.variationProfile?.voiceEdge || '',
              tropeFingerprint: plan.tropeFingerprint || ''
            },
            candidates: picked.ranked.map((item) => ({
              fingerprint: item.fingerprint,
              score: item.score,
              similarity: item.similarity,
              noveltyScore: item.noveltyScore,
              tropeCollisionScore: item.tropeCollisionScore,
              circleNaturalnessScore: item.circleNaturalnessScore,
              edgeTensionScore: item.edgeTensionScore,
              variantType: item.variantType,
              tropeFingerprint: item.tropeFingerprint,
              rejected: item.rejected,
              rejectionReason: item.rejectionReason
            }))
          }));
          return {
            text: picked.selected.text,
            fingerprint: picked.selected.fingerprint,
            variationProfile: plan.variationProfile || null,
            topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : (payload.topicGroup || ''),
            plan,
            candidates: picked.ranked,
            meta: {
              ...qzoneMemoryMeta,
              similarity: picked.selected.similarity,
              selectedScore: picked.selected.score,
              noveltyScore: picked.selected.noveltyScore,
              tropeCollisionScore: picked.selected.tropeCollisionScore,
              circleNaturalnessScore: picked.selected.circleNaturalnessScore,
              edgeTensionScore: picked.selected.edgeTensionScore,
              memoryEvidenceSources: Array.isArray(qzoneMemoryMeta.memoryEvidenceSources) && qzoneMemoryMeta.memoryEvidenceSources.length
                ? qzoneMemoryMeta.memoryEvidenceSources
                : (Array.isArray(qzoneMemoryEvidence.sources) ? qzoneMemoryEvidence.sources : [])
            }
          };
        }
        lastFailure = picked.ranked[0]?.rejectionReason || 'qzone_phase2_candidate_rejected';
        lastFailureClass = 'similarity';
        appendQzoneGenerationLog(normalizeTelemetryPayload({
          source: 'daily_share',
          type,
          groupId: targetId,
          status: 'failed',
          selectedFingerprint: '',
          selectedScore: 0,
          similarity: 0,
          failureReasons: picked.ranked.map((item) => item.rejectionReason).filter(Boolean),
          planSummary: {
            fingerprint: plan.fingerprint,
            topicKey: plan.theme?.key || payload.topicKey || '',
            topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : (payload.topicGroup || ''),
            lens: plan.variationProfile?.lens || '',
            anchor: plan.variationProfile?.anchor || '',
            structure: plan.variationProfile?.structure || '',
            arc: plan.variationProfile?.arc || '',
            tempo: plan.variationProfile?.tempo || '',
            distance: plan.variationProfile?.distance || '',
            spark: plan.variationProfile?.spark || '',
            socialMask: plan.variationProfile?.socialMask || '',
            freshnessMode: plan.variationProfile?.freshnessMode || '',
            voiceEdge: plan.variationProfile?.voiceEdge || '',
            tropeFingerprint: plan.tropeFingerprint || ''
          },
          candidates: picked.ranked.map((item) => ({
            fingerprint: item.fingerprint,
            score: item.score,
            similarity: item.similarity,
            noveltyScore: item.noveltyScore,
            tropeCollisionScore: item.tropeCollisionScore,
            circleNaturalnessScore: item.circleNaturalnessScore,
            edgeTensionScore: item.edgeTensionScore,
            variantType: item.variantType,
            tropeFingerprint: item.tropeFingerprint,
            rejected: item.rejected,
            rejectionReason: item.rejectionReason
          }))
        }));
      }
      throw new Error(lastFailure || 'daily-share-validation-failed');
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const variationProfile = normalizedSurface === 'qzone'
        ? sampleVariationProfile({
          source: 'daily_share',
          type,
          windowKey,
          groupId: targetId,
          today: stateEntry?.today || '',
          attempt,
          now,
          recentHistory: recentQzoneHistory
        })
        : null;
      const promptBase = normalizedSurface === 'qzone' && typeof payload.buildPrompt === 'function'
        ? payload.buildPrompt({
          variationProfile,
          recentHistory: recentQzoneHistory
        })
        : payload.prompt;
      const prompt = attempt === 0
        ? [promptBase, payload.prompt].filter(Boolean).join('\n\n')
        : [
          promptBase,
          payload.prompt,
          buildVariationConstraintPrompt({ recentHistory: recentQzoneHistory }),
          `上一次结果不合格，失败原因：${lastFailure || 'unknown'}。这次必须避开相同问题并重新生成。`
        ].filter(Boolean).join('\n\n');
      const modelConfig = normalizedSurface === 'qzone'
        ? getModelConfigForQzoneAttempt(lastFailureClass)
        : null;
      const reply = await askAIByGraph(prompt, userInfo, userId, prompt, null, {
        systemInitiated: true,
        topRouteType: 'proactive',
        routePolicyKey: 'proactive/daily-share',
        disableTools: true,
        disableStream: true,
        disableMemoryLearning: true,
        modelConfig,
        routeMeta: {
          groupId: String(groupId || ''),
          taskType: 'daily_share',
          channelId: String(targetId),
          windowKey,
          shareType: type,
          surface: normalizedSurface
        }
      });

      const text = trimReplyText(reply, 260);
      if (!text) {
        lastFailure = 'empty-daily-share-reply';
        lastFailureClass = 'validation';
        continue;
      }

      const validation = validateDailyShareOutput(text, type, normalizedSurface);
      if (!validation.ok) {
        lastFailure = validation.reason;
        lastFailureClass = 'validation';
        logDailyShare({
          groupId: targetId,
          windowKey,
          type,
          reason: validation.reason,
          source: payload.source || '',
          event: attempt === 0 ? 'validator retry' : 'validator fail'
        });
        continue;
      }

      const fingerprint = normalizeDailyShareFingerprint(text);
      const recentFingerprints = (Array.isArray(stateEntry.recentContentFingerprints) ? stateEntry.recentContentFingerprints : [])
        .map((item) => String(item?.key || '').trim().toLowerCase())
        .filter(Boolean);
      if (fingerprint && recentFingerprints.includes(fingerprint)) {
        lastFailure = 'recent-content-duplicate';
        lastFailureClass = 'duplicate';
        logDailyShare({
          groupId: targetId,
          windowKey,
          type,
          reason: lastFailure,
          source: payload.source || '',
          event: attempt === 0 ? 'validator retry' : 'validator fail'
        });
        continue;
      }

      return {
        text,
        fingerprint,
        variationProfile: null,
        topicGroup: payload.topicGroup || '',
        meta: {
          ...qzoneMemoryMeta,
          memoryEvidenceSources: Array.isArray(qzoneMemoryMeta.memoryEvidenceSources) && qzoneMemoryMeta.memoryEvidenceSources.length
            ? qzoneMemoryMeta.memoryEvidenceSources
            : (Array.isArray(qzoneMemoryEvidence.sources) ? qzoneMemoryEvidence.sources : [])
        }
      };
    }

    throw new Error(lastFailure || 'daily-share-validation-failed');
  }

  async function sendShare({
    sendWithRetry,
    askAIByGraph,
    groupId,
    windowKey,
    type,
    today = getToday(),
    advancePointer = false,
    manual = false,
    now = Date.now(),
    surface = 'group'
  }) {
    const normalizedSurface = String(surface || 'group').trim().toLowerCase() || 'group';
    const targetId = normalizedSurface === 'qzone' ? QZONE_TARGET_ID : groupId;
    const { target, stateEntry } = ensureTargetState(targetId, today);
    const windowDef = getWindowDefinitions(target).find((item) => item.key === windowKey) || {
      key: windowKey,
      label: windowKey,
      startMinutes: 0,
      endMinutes: 0
    };

    const payload = await resolvedContentBuilder.build({
      type,
      groupId,
      windowKey,
      windowLabel: windowDef.label,
      stateEntry,
      targetConfig: target,
      today,
      now,
      surface: normalizedSurface
    });
    payload.windowLabel = payload.windowLabel || windowDef.label;

    if (payload.topicRelaxed) {
      logDailyShare({
        groupId: targetId,
        windowKey,
        type,
        reason: 'topic-relaxed-7d',
        event: 'dedupe relaxed'
      });
    }

    const generated = await generateValidatedShare({
      askAIByGraph,
      targetId,
      groupId,
      windowKey,
      type,
      payload,
      stateEntry,
      now,
      surface: normalizedSurface
    });

    let initiativeLockOwner = '';
    let initiativePolicy = null;
    if (normalizedSurface === 'group') {
      initiativePolicy = evaluateInitiativePolicy({
        source: 'daily_share',
        groupId,
        userId: '',
        candidateReason: 'daily_share',
        contextHints: {
          primaryContext: type,
          secondaryContext: payload?.topicLabel || '',
          windowKey
        }
      }, now);
      if (!initiativePolicy.allowed) {
        const status = stateEntry.windowStatus[windowKey];
        const schedule = stateEntry.scheduleByWindow[windowKey];
        schedule.deferred = true;
        schedule.deferredAt = now + (Math.max(1, Number(target.deferMinutes || 8)) * 60 * 1000);
        status.status = 'deferred';
        status.lastReason = initiativePolicy.reason;
        status.lastAttemptAt = now;
        flush();
        return { sent: false, deferred: true, reason: initiativePolicy.reason, text: '' };
      }
      initiativeLockOwner = `daily_share:${groupId}:${windowKey}:${type}`;
      const initiativeLock = acquireInitiativeLock({
        groupId,
        owner: initiativeLockOwner,
        now
      });
      if (!initiativeLock.acquired) {
        return { sent: false, deferred: true, reason: initiativeLock.reason, text: '' };
      }
    }

    let deliveredText = generated.text;
    try {
      if (normalizedSurface === 'qzone') {
        const publish = typeof qzonePublisher === 'function'
          ? qzonePublisher
          : async (payload) => runQzoneAgent(payload, {
            groupId: QZONE_TARGET_ID,

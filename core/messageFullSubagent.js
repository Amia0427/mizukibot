const { buildRuntimePrompt } = require('../utils/runtimePrompts');
const { buildSubagentStyleGuardInstruction, prepareSubagentFallbackReply, prepareSubagentOutputForReview } = require('../utils/subagentStyleGuard');
const {
  buildReviewStageRoutePrompt,
  buildReviewStageSystemPrompt
} = require('../utils/stagePromptContracts');

function clampFullSubagentWorkerCount(value, fallback = 2, maxWorkers = 2) {
  const fallbackCount = Math.max(1, Math.min(2, Number(fallback) || 1));
  const hardMax = Math.max(1, Math.min(2, Number(maxWorkers) || 2));
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return Math.min(fallbackCount, hardMax);
  return Math.max(1, Math.min(hardMax, parsed));
}

function normalizeFullSubagentWorker(worker = {}, fallbackIndex = 0) {
  const index = Math.max(1, Number(fallbackIndex) || 1);
  const rawMustCover = Array.isArray(worker?.mustCover) ? worker.mustCover : [];
  const mustCover = rawMustCover
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 8);

  return {
    id: String(worker?.id || `w${index}`).trim() || `w${index}`,
    title: String(worker?.title || `Worker ${index}`).trim() || `Worker ${index}`,
    objective: String(worker?.objective || '').trim(),
    mustCover,
    deliverable: String(worker?.deliverable || '').trim()
  };
}

function buildSingleWorkerFallbackPlan(question = '') {
  const cleanQuestion = String(question || '').trim() || '(empty)';
  return {
    workerCount: 1,
    workers: [
      {
        id: 'w1',
        title: 'Primary worker',
        objective: cleanQuestion,
        mustCover: ['Address the full original task directly.'],
        deliverable: 'Produce the best complete answer possible for the original /full request.'
      }
    ],
    reviewFocus: 'Merge carefully, keep failures and uncertainty visible, do not invent extra execution.'
  };
}

function normalizeNonNegativeInt(value, fallback) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) return fallback;
  return num;
}

function withTimeout(promise, timeoutMs, onTimeout) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          if (typeof onTimeout === 'function') onTimeout();
        } catch (_) {}
        reject(new Error(`full subagent worker timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}

function normalizeFullSubagentPlan(rawPlan, options = {}) {
  const {
    question = '',
    maxWorkers = 2,
    extractJsonSafely
  } = options && typeof options === 'object' ? options : {};

  const parsed = rawPlan && typeof rawPlan === 'object' && !Array.isArray(rawPlan)
    ? rawPlan
    : extractJsonSafely(rawPlan);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return buildSingleWorkerFallbackPlan(question);
  }

  const hardMax = Math.max(1, Math.min(2, Number(maxWorkers) || 2));
  const rawWorkers = Array.isArray(parsed.workers) ? parsed.workers : [];
  const normalizedWorkers = rawWorkers
    .slice(0, hardMax)
    .map((worker, index) => normalizeFullSubagentWorker(worker, index + 1))
    .filter((worker) => worker.objective || worker.mustCover.length || worker.deliverable);

  const desiredCount = clampFullSubagentWorkerCount(
    parsed.workerCount,
    normalizedWorkers.length || 1,
    hardMax
  );

  if (!normalizedWorkers.length) {
    return buildSingleWorkerFallbackPlan(question);
  }

  const workers = normalizedWorkers.slice(0, desiredCount).map((worker, index) => ({
    ...worker,
    id: `w${index + 1}`
  }));

  if (!workers.length) {
    return buildSingleWorkerFallbackPlan(question);
  }

  return {
    workerCount: workers.length,
    workers,
    reviewFocus: String(parsed.reviewFocus || '').trim()
      || 'Merge overlap, resolve conflicts conservatively, keep failures and uncertainty explicit.'
  };
}

function buildFullSubagentCoordinatorPayload(question = '', routePrompt = null, maxWorkers = 2) {
  const workerLimit = clampFullSubagentWorkerCount(maxWorkers, 2, 2);
  const routePromptBlock = String(routePrompt || '').trim()
    ? `Route guidance:\n${String(routePrompt || '').trim()}`
    : '';

  return [
    'Return JSON only.',
    'Plan a `/full` admin task into 1 or 2 worker assignments.',
    'If splitting is weak or artificial, use exactly 1 worker.',
    'Do not mention tools, sessions, or implementation internals in the plan.',
    'Required JSON schema:',
    '{"workerCount":1,"workers":[{"id":"w1","title":"string","objective":"string","mustCover":["string"],"deliverable":"string"}],"reviewFocus":"string"}',
    `Max workers: ${workerLimit}`,
    routePromptBlock,
    'Original /full request:',
    String(question || '').trim() || '(empty)'
  ].filter(Boolean).join('\n\n');
}

function buildFullSubagentWorkerPrompt(question = '', worker = {}, plan = {}) {
  const mustCover = Array.isArray(worker?.mustCover) ? worker.mustCover.filter(Boolean) : [];
  const allWorkers = Array.isArray(plan?.workers) ? plan.workers : [];
  const boundaryLines = allWorkers
    .filter((entry) => entry && String(entry.id || '').trim() && String(entry.id || '').trim() !== String(worker?.id || '').trim())
    .map((entry) => `- ${String(entry.id || '').trim()}: ${String(entry.title || '').trim() || 'other worker'} -> ${String(entry.objective || '').trim() || 'adjacent coverage'}`);

  return [
    'You are one worker in an admin `/full` multi-worker run.',
    'Complete only your assigned scope. Do not assume the other worker completed your part.',
    'Do not claim to have searched, read, verified, executed, or observed anything you did not actually do.',
    'Output structured plain text that a local reviewer can merge directly.',
    buildSubagentStyleGuardInstruction({ maxChars: 1600 }),
    '',
    `Original task:\n${String(question || '').trim() || '(empty)'}`,
    `Worker id: ${String(worker?.id || '').trim() || 'w1'}`,
    `Worker title: ${String(worker?.title || '').trim() || 'Worker'}`,
    `Objective:\n${String(worker?.objective || '').trim() || 'Address the assigned part of the original task.'}`,
    mustCover.length ? `Must cover:\n${mustCover.map((item) => `- ${item}`).join('\n')}` : '',
    String(worker?.deliverable || '').trim() ? `Deliverable:\n${String(worker.deliverable).trim()}` : '',
    boundaryLines.length ? `Other worker boundaries:\n${boundaryLines.join('\n')}` : '',
    'Structure your output with these sections if applicable:',
    '- Findings',
    '- Evidence',
    '- Gaps or limits',
    '- Suggested final wording'
  ].filter(Boolean).join('\n\n');
}

function summarizeFullWorkerError(error, worker = {}) {
  const label = String(worker?.id || 'worker').trim() || 'worker';
  const message = String(error?.message || error || 'unknown error').trim() || 'unknown error';
  return `${label} failed: ${message}`;
}

function formatFullWorkerResultForReview(result = {}) {
  const worker = result?.worker || {};
  const status = String(result?.status || 'unknown').trim() || 'unknown';
  const output = prepareSubagentOutputForReview(result?.output || '', { maxChars: 2400 });
  const error = String(result?.error || '').trim();

  return [
    `Worker ${String(worker.id || '').trim() || 'unknown'} (${String(worker.title || '').trim() || 'untitled'})`,
    `Status: ${status}`,
    worker.objective ? `Objective: ${String(worker.objective).trim()}` : '',
    output ? `Output:\n${output}` : '',
    error ? `Error:\n${error}` : ''
  ].filter(Boolean).join('\n');
}

function buildFullSubagentReviewPayload(question = '', plan = {}, workerResults = [], routePolicyKey = 'admin/full') {
  const normalizedResults = Array.isArray(workerResults) ? workerResults : [];
  const workerBlocks = normalizedResults.length
    ? normalizedResults.map((entry) => formatFullWorkerResultForReview(entry)).join('\n\n---\n\n')
    : 'No worker results.';

  const workerPlanBlock = Array.isArray(plan?.workers) && plan.workers.length
    ? plan.workers.map((worker) => [
      `- ${String(worker.id || '').trim() || 'w?'}`,
      String(worker.title || '').trim() || 'untitled',
      String(worker.objective || '').trim() || 'no objective'
    ].join(' | ')).join('\n')
    : '- w1 | Primary worker | Address the original task directly';

  return [
    `Task policy: ${String(routePolicyKey || 'admin/full').trim() || 'admin/full'}`,
    '',
    'Original /full request:',
    String(question || '').trim() || '(empty)',
    '',
    'Coordinator plan:',
    `workerCount: ${Number(plan?.workerCount) || 1}`,
    workerPlanBlock,
    '',
    `Review focus: ${String(plan?.reviewFocus || '').trim() || 'Merge carefully and keep limits visible.'}`,
    '',
    'Worker results:',
    workerBlocks,
    '',
    'Return one final admin reply only.'
  ].join('\n');
}

function chooseBestFullSubagentWorkerOutput(workerResults = []) {
  const normalizedResults = Array.isArray(workerResults) ? workerResults : [];
  const successes = normalizedResults.filter((entry) => String(entry?.status || '').trim() === 'fulfilled' && String(entry?.output || '').trim());
  if (!successes.length) return '';

  successes.sort((a, b) => String(b.output || '').trim().length - String(a.output || '').trim().length);
  return String(successes[0]?.output || '').trim();
}

function buildFullSubagentFallbackReply(workerResults = []) {
  const normalizedResults = Array.isArray(workerResults) ? workerResults : [];
  const best = chooseBestFullSubagentWorkerOutput(normalizedResults);
  if (best) return prepareSubagentFallbackReply(best);

  const fragments = normalizedResults
    .map((entry) => {
      const workerId = String(entry?.worker?.id || '').trim();
      const output = String(entry?.output || '').trim();
      const error = String(entry?.error || '').trim();
      if (output) return workerId ? `[${workerId}] ${output}` : output;
      if (error) return workerId ? `[${workerId}] ${error}` : error;
      return '';
    })
    .filter(Boolean);

  if (fragments.length) return prepareSubagentFallbackReply(fragments.join('\n\n'));
  return 'This /full run did not produce a usable worker result.';
}

function buildFullSubagentAllWorkersFailedReply(workerResults = []) {
  const normalizedResults = Array.isArray(workerResults) ? workerResults : [];
  const failures = normalizedResults
    .map((entry) => String(entry?.error || '').trim())
    .filter(Boolean);
  if (!failures.length) {
    return '所有 worker 都失败了，而且没有产出可用结果。';
  }
  return [
    '所有 worker 都失败了。',
    failures.map((line) => `- ${line}`).join('\n')
  ].join('\n');
}

function createMessageFullSubagentCoordinator(deps = {}) {
  const {
    config,
    askAIByGraph,
    extractJsonSafely,
    cleanToolReplyText,
    resolveToolReplyFormattingPreferences,
    buildToolReplyFormatInstruction,
    startSubagentBridgeCall,
    buildRuntimePromptOverride = buildRuntimePrompt
  } = deps;
  const workerTimeoutMs = normalizeNonNegativeInt(config.FULL_SUBAGENT_WORKER_TIMEOUT_MS, 0);
  const reviewTimeoutMs = normalizeNonNegativeInt(config.FULL_SUBAGENT_REVIEW_TIMEOUT_MS, 0);

  function buildSubagentReviewPayload(question, subagentOutput, routePolicyKey = 'tool/review') {
    return buildRuntimePromptOverride('review-payload', {
      routeKey: routePolicyKey,
      question: String(question || '').trim() || '(empty)',
      subagentOutput: String(subagentOutput || '').trim() || '(empty)'
    });
  }

  async function reviewSubagentOutput({
    question,
    subagentOutput,
    userInfo,
    userId,
    imageUrl = null,
    routePrompt = null,
    routePolicyKey = 'tool/review'
  }) {
    const formattingPreferences = resolveToolReplyFormattingPreferences(question);
    const outputFormatInstruction = buildToolReplyFormatInstruction(formattingPreferences);
    const reviewSystemPrompt = buildReviewStageSystemPrompt({
      extraInstruction: outputFormatInstruction
    });

    const reviewRoutePrompt = buildReviewStageRoutePrompt({
      routePromptBlock: routePrompt ? `路由提示:\n${routePrompt}` : '',
      outputFormatInstruction
    });

    const guardedSubagentOutput = prepareSubagentOutputForReview(subagentOutput, { requestText: question });
    const reviewInput = buildSubagentReviewPayload(question, guardedSubagentOutput, routePolicyKey);
    return askAIByGraph(reviewInput, userInfo, userId, reviewSystemPrompt, imageUrl, {
      routePrompt: reviewRoutePrompt,
      routePolicyKey,
      reviewMode: 'subagent_output',
      disableStream: true,
      disableTools: true,
      routeMeta: {
        requestText: question
      }
    });
  }

  async function planFullSubagentWorkers({
    question,
    userInfo,
    userId,
    imageUrl = null,
    routePrompt = null,
    routePolicyKey = 'admin/full'
  }) {
    const maxWorkers = clampFullSubagentWorkerCount(config.FULL_SUBAGENT_MAX_WORKERS, 2, 2);
    const prompt = buildFullSubagentCoordinatorPayload(question, routePrompt, maxWorkers);
    let rawPlan = '';

    try {
      rawPlan = await askAIByGraph(prompt, userInfo, userId, String(config.SYSTEM_PROMPT || '').trim(), imageUrl, {
        routePrompt: 'Plan the admin `/full` task into up to two workers. Return JSON only.',
        routePolicyKey,
        topRouteType: 'admin',
        reviewMode: 'full_subagent_plan',
        disableTools: true,
        disableStream: true,
        modelConfig: {
          model: 'gpt-5.4-mini'
        },
        routeMeta: {
          requestText: question,
          topRouteType: 'admin',
          routePolicyKey
        }
      });
    } catch (error) {
      console.error('[full-subagent] coordinator failed, fallback to single worker:', error?.message || error);
      return buildSingleWorkerFallbackPlan(question);
    }

    return normalizeFullSubagentPlan(rawPlan, {
      question,
      maxWorkers,
      extractJsonSafely
    });
  }

  async function reviewFullMultiWorkerOutput({
    question,
    plan,
    workerResults,
    userInfo,
    userId,
    imageUrl = null,
    routePrompt = null,
    routePolicyKey = 'admin/full'
  }) {
    const formattingPreferences = resolveToolReplyFormattingPreferences(question);
    const outputFormatInstruction = buildToolReplyFormatInstruction(formattingPreferences);
    const reviewSystemPrompt = buildReviewStageSystemPrompt({
      extraInstruction: outputFormatInstruction
    });
    const reviewRoutePrompt = buildReviewStageRoutePrompt({
      routePromptBlock: routePrompt ? `Routing guidance:\n${routePrompt}` : '',
      outputFormatInstruction
    });
    const guardedWorkerResults = (Array.isArray(workerResults) ? workerResults : []).map((entry) => ({
      ...entry,
      output: prepareSubagentOutputForReview(entry?.output || '', { requestText: question })
    }));
    const reviewInput = buildFullSubagentReviewPayload(question, plan, guardedWorkerResults, routePolicyKey);
    return askAIByGraph(reviewInput, userInfo, userId, reviewSystemPrompt, imageUrl, {
      routePrompt: reviewRoutePrompt,
      routePolicyKey,
      topRouteType: 'admin',
      reviewMode: 'full_subagent_multi_review',
      disableTools: true,
      disableStream: true,
      routeMeta: {
        requestText: question,
        topRouteType: 'admin',
        routePolicyKey
      }
    });
  }

  async function executeFullMultiWorkerTaskWithHandle(question, userInfo, userId, imageUrl = null, options = {}) {
    const mutableOptions = options && typeof options === 'object' ? { ...options } : {};
    mutableOptions.routePrompt = String(mutableOptions.routePrompt || '').trim() || null;
    const routePolicyKey = String(mutableOptions.routePolicyKey || 'admin/full').trim() || 'admin/full';
    const formattingPreferences = resolveToolReplyFormattingPreferences(question);
    const backgroundTaskId = String(mutableOptions.backgroundTaskId || '').trim();
    const shouldContinue = typeof mutableOptions?.shouldContinue === 'function'
      ? mutableOptions.shouldContinue
      : () => true;
    const workerCancels = [];
    let completedWorkers = 0;
    const backgroundTaskRuntime = mutableOptions.backgroundTaskRuntime;
    const looksLikeModelFailureText = mutableOptions.looksLikeModelFailureText;

    const updateTaskStage = (stage, latestSummary = '') => {
      if (!backgroundTaskId || !backgroundTaskRuntime) return;
      backgroundTaskRuntime.markTaskStatus(backgroundTaskId, {
        status: stage === 'reviewing' ? 'reviewing' : 'running',
        stage,
        latest_summary: String(latestSummary || '').trim()
      });
    };

    if (!(config.SUBAGENT_ENABLED || config.NANOBOT_BRIDGE_ENABLED)) {
      return {
        promise: Promise.resolve('?????????????? agent??? agent ?????????? `.env` ?? `SUBAGENT_ENABLED`?`SUBAGENT_COMMAND` ? `OPENCLAW_*` ???'),
        cancel() {}
      };
    }

    const promise = (async () => {
      console.log('[full-subagent] multi-agent start', {
        executor: 'full_subagent',
        multiAgent: true,
        subagentBackend: String(config.SUBAGENT_BACKEND || 'command').trim() || 'command'
      });

      updateTaskStage('planning', 'planning worker split');
      const planStartedAt = Date.now();
      const plan = await planFullSubagentWorkers({
        question,
        userInfo,
        userId,
        imageUrl,
        routePrompt: mutableOptions.routePrompt,
        routePolicyKey
      });
      const workerCount = clampFullSubagentWorkerCount(plan?.workerCount, 1, config.FULL_SUBAGENT_MAX_WORKERS);
      console.log('[full-subagent] planning completed', {
        executor: 'full_subagent',
        multiAgent: true,
        workerCount,
        planDurationMs: Date.now() - planStartedAt
      });

      if (!shouldContinue()) return '';

      updateTaskStage('workers_running', `workers 0/${workerCount}`);
      const workerStartedAt = Date.now();
      const workerPromises = (Array.isArray(plan?.workers) ? plan.workers : []).slice(0, workerCount).map(async (worker, index) => {
        const workerId = String(worker?.id || `w${index + 1}`).trim() || `w${index + 1}`;
        const workerPrompt = buildFullSubagentWorkerPrompt(question, worker, plan);
        console.log('[full-subagent] worker started', {
          executor: 'full_subagent',
          multiAgent: true,
          workerId,
          workerTitle: String(worker?.title || '').trim(),
          workerCount
        });

        try {
          const bridgeCall = await startSubagentBridgeCall(question, userInfo, userId, null, imageUrl, {
            ...mutableOptions,
            sessionSuffix: `full:${workerId}`,
            routePrompt: mutableOptions.routePrompt,
            subagentRoutePrompt: workerPrompt,
            routePolicyKey,
            topRouteType: 'admin'
          });
          workerCancels.push((reason) => bridgeCall.cancel(reason));
          const output = await withTimeout(bridgeCall.promise, workerTimeoutMs, () => bridgeCall.cancel('timeout'));
          const cleanOutput = prepareSubagentOutputForReview(
            cleanToolReplyText(output, formattingPreferences),
            { requestText: question }
          );
          console.log('[full-subagent] worker completed', {
            executor: 'full_subagent',
            multiAgent: true,
            workerId,
            workerCount
          });
          return {
            worker,
            status: 'fulfilled',
            output: cleanOutput,
            error: ''
          };
        } catch (error) {
          const failureText = summarizeFullWorkerError(error, worker);
          console.error('[full-subagent] worker failed', {
            executor: 'full_subagent',
            multiAgent: true,
            workerId,
            workerCount,
            error: failureText
          });
          return {
            worker,
            status: 'rejected',
            output: '',
            error: failureText
          };
        } finally {
          if (backgroundTaskId && backgroundTaskRuntime) {
            completedWorkers += 1;
            backgroundTaskRuntime.markTaskStatus(backgroundTaskId, {
              status: 'running',
              stage: 'workers_running',
              latest_summary: `workers ${Math.min(completedWorkers, workerCount)}/${workerCount}`
            });
          }
        }
      });

      const settled = await Promise.allSettled(workerPromises);
      const workerResults = settled.map((entry, index) => {
        if (entry.status === 'fulfilled') return entry.value;
        const worker = plan.workers[index] || { id: `w${index + 1}` };
        return {
          worker,
          status: 'rejected',
          output: '',
          error: summarizeFullWorkerError(entry.reason, worker)
        };
      });

      const successCount = workerResults.filter((entry) => entry.status === 'fulfilled' && String(entry.output || '').trim()).length;
      console.log('[full-subagent] workers finished', {
        executor: 'full_subagent',
        multiAgent: true,
        workerCount,
        successCount,
        workerDurationMs: Date.now() - workerStartedAt
      });

      if (!shouldContinue()) return '';
      if (successCount <= 0) {
        return buildFullSubagentAllWorkersFailedReply(workerResults);
      }

      updateTaskStage('reviewing', `workers ${workerCount}/${workerCount}, reviewing`);
      const reviewStartedAt = Date.now();
      console.log('[full-subagent] review started', {
        executor: 'full_subagent',
        multiAgent: true,
        workerCount
      });
      try {
        const reviewed = await withTimeout(reviewFullMultiWorkerOutput({
          question,
          plan,
          workerResults,
          userInfo,
          userId,
          imageUrl,
          routePrompt: mutableOptions.routePrompt,
          routePolicyKey
        }), reviewTimeoutMs);
        if (!shouldContinue()) return '';
        if (String(reviewed || '').trim()) {
          const cleanReviewed = prepareSubagentFallbackReply(
            cleanToolReplyText(reviewed, formattingPreferences),
            { requestText: question }
          );
          if (cleanReviewed && !(typeof looksLikeModelFailureText === 'function' && looksLikeModelFailureText(cleanReviewed))) {
            console.log('[full-subagent] review completed', {
              executor: 'full_subagent',
              multiAgent: true,
              workerCount,
              reviewCompleted: true,
              reviewDurationMs: Date.now() - reviewStartedAt
            });
            return cleanReviewed;
          }
        }
      } catch (error) {
        console.error('[full-subagent] review failed, fallback to best worker output', {
          executor: 'full_subagent',
          multiAgent: true,
          workerCount,
          error: error?.message || error
        });
      }

      console.log('[full-subagent] review fallback', {
        executor: 'full_subagent',
        multiAgent: true,
        workerCount,
        reviewFallback: true
      });
      return buildFullSubagentFallbackReply(workerResults);
    })().catch((error) => {
      if (error && /cancelled/i.test(String(error?.message || ''))) {
        return '';
      }
      console.error('[full-subagent] multi-agent execute failed:', error?.message || error);
      return '?? `/full` ? worker ????????????????';
    });

    return {
      promise,
      cancel(reason = 'cancelled') {
        for (const fn of workerCancels) {
          try { fn(reason); } catch (_) {}
        }
        return reason;
      }
    };
  }

  return {
    buildFullSubagentAllWorkersFailedReply,
    buildFullSubagentCoordinatorPayload,
    buildFullSubagentFallbackReply,
    buildFullSubagentReviewPayload,
    buildFullSubagentWorkerPrompt,
    buildSingleWorkerFallbackPlan,
    chooseBestFullSubagentWorkerOutput,
    executeFullMultiWorkerTaskWithHandle,
    handleFullAdminCommand: async function handleFullAdminCommand({
      route,
      groupId,
      senderId,
      userInfo,
      rawText,
      sendGroupReply,
      normalizeUserFacingReply,
      askToolTaskWithSubagentReview,
      routeExecution,
      runBackgroundToolTask,
      executeFullSubagentTaskWithHandle
    }) {
      const command = route?.meta?.command || {};
      const payload = String(command.payload || command.args?.[0] || '').trim();
      if (!route?.meta?.admin) {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: '????????? /full?',
          atSender: true,
          retries: 1,
          waitMs: 300
        });
        return true;
      }

      if (!payload) {
        await sendGroupReply({
          groupId,
          senderId,
          replyText: '/full ????????????',
          atSender: true,
          retries: 1,
          waitMs: 300
        });
        return true;
      }

      const routeExecutionPlan = routeExecution.resolveRouteExecution(route, config, {});
      const sessionChatId = `group_${groupId}_user_${senderId}`;
      const fullExecutionHandleFactory = executeFullSubagentTaskWithHandle;
      const fullPrompt = [
        '??? /full ???????????????',
        '?????? direct_chat?',
        payload
      ].join('\n\n');

      if (config.BACKGROUND_TOOL_TASKS_ENABLED) {
        await runBackgroundToolTask({
          route,
          routeExecutionPlan,
          cleanText: payload,
          imageUrl: route?.imageUrl || null,
          userInfo,
          senderId,
          groupId,
          toolTaskOptions: {
            routePrompt: fullPrompt,
            subagentRoutePrompt: fullPrompt,
            sessionChannel: 'qq-group',
            sessionChatId,
            routePolicyKey: 'admin/full',
            topRouteType: 'admin',
            routeMeta: {
              ...(route?.meta || {}),
              groupId,
              topRouteType: 'admin',
              routePolicyKey: 'admin/full'
            }
          },
          executionHandleFactory: config.FULL_SUBAGENT_MULTI_AGENT_ENABLED
            ? executeFullMultiWorkerTaskWithHandle
            : fullExecutionHandleFactory,
          initialStage: config.FULL_SUBAGENT_MULTI_AGENT_ENABLED ? 'planning' : 'running'
        });
        return true;
      }

      const fullTaskOptions = {
        routePrompt: fullPrompt,
        subagentRoutePrompt: fullPrompt,
        sessionChannel: 'qq-group',
        sessionChatId,
        routePolicyKey: 'admin/full',
        topRouteType: 'admin',
        routeMeta: {
          ...(route?.meta || {}),
          groupId,
          topRouteType: 'admin',
          routePolicyKey: 'admin/full',
          rawText
        }
      };

      const reply = config.FULL_SUBAGENT_MULTI_AGENT_ENABLED
        ? await (await executeFullMultiWorkerTaskWithHandle(payload, userInfo, senderId, route?.imageUrl || null, fullTaskOptions)).promise
        : await askToolTaskWithSubagentReview(payload, userInfo, senderId, null, route?.imageUrl || null, fullTaskOptions);

      await sendGroupReply({
        groupId,
        senderId,
        replyText: normalizeUserFacingReply(reply, {
          routeDebugKey: 'admin/full',
          topRouteType: 'admin',
          allowTools: false,
          subagentRefill: true,
          requestText: payload
        }),
        atSender: true,
        retries: 1,
        waitMs: 300
      });
      return true;
    },
    normalizeFullSubagentPlan,
    planFullSubagentWorkers,
    reviewFullMultiWorkerOutput,
    reviewSubagentOutput,
    summarizeFullWorkerError
  };
}

module.exports = {
  buildFullSubagentAllWorkersFailedReply,
  buildFullSubagentCoordinatorPayload,
  buildFullSubagentFallbackReply,
  buildFullSubagentReviewPayload,
  buildFullSubagentWorkerPrompt,
  buildSingleWorkerFallbackPlan,
  chooseBestFullSubagentWorkerOutput,
  clampFullSubagentWorkerCount,
  createMessageFullSubagentCoordinator,
  normalizeFullSubagentPlan,
  normalizeFullSubagentWorker,
  summarizeFullWorkerError
};

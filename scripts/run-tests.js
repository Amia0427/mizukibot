const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_TEST_TEMP_ROOT = path.resolve(
  PROJECT_ROOT,
  '..',
  `${path.basename(PROJECT_ROOT)}-test-temp`
);

function listTestFiles(rootDir) {
  const discovered = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.test.js')) {
        discovered.push(fullPath);
      }
    }
  }
  return discovered.sort((a, b) => a.localeCompare(b));
}

const testFiles = [
  path.join(__dirname, '..', 'tests', 'config.test.js'),
  path.join(__dirname, '..', 'tests', 'configEnvFallback.test.js'),
  path.join(__dirname, '..', 'tests', 'envFile.test.js'),
  path.join(__dirname, '..', 'tests', 'networkSafety.test.js'),
  path.join(__dirname, '..', 'tests', 'httpClientSecurity.test.js'),
  path.join(__dirname, '..', 'tests', 'webAuthSecurity.test.js'),
  path.join(__dirname, '..', 'tests', 'memory.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryProjection.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3Query.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3RecallPlan.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3SessionRestore.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3PersonaCore.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3WeakEvidence.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3RelationshipFacet.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3StyleFacet.test.js'),
  path.join(__dirname, '..', 'tests', 'personaMemoryState.test.js'),
  path.join(__dirname, '..', 'tests', 'guanxiPrompt.test.js'),
  path.join(__dirname, '..', 'tests', 'personaMemoryPersistNode.test.js'),
  path.join(__dirname, '..', 'tests', 'localKnowledge.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3IdentityFacet.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3ContinuityFacet.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3PreferenceFacet.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3ScopeBoundary.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryCliOpenBoundary.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryPacketBudget.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryCliV3.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3MigrationScript.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryEmbeddingClient.test.js'),
  path.join(__dirname, '..', 'tests', 'memorySemanticRecall.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryRerankClient.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryHybridRerankPipeline.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryConflictFilteringStable.test.js'),
  path.join(__dirname, '..', 'tests', 'recallHeuristics.test.js'),
  path.join(__dirname, '..', 'tests', 'routerChineseKeywords.test.js'),
  path.join(__dirname, '..', 'tests', 'messageCopyMojibake.test.js'),
  path.join(__dirname, '..', 'tests', 'messageVisualContext.test.js'),
  path.join(__dirname, '..', 'tests', 'messageIngressNotice.test.js'),
  path.join(__dirname, '..', 'tests', 'llmPerceptionSenderName.test.js'),
  path.join(__dirname, '..', 'tests', 'messageAdminCommands.test.js'),
  path.join(__dirname, '..', 'tests', 'messageReplyRuntimeControl.test.js'),
  path.join(__dirname, '..', 'tests', 'messageTelemetry.test.js'),
  path.join(__dirname, '..', 'tests', 'messageBackgroundTasks.test.js'),
  path.join(__dirname, '..', 'tests', 'promptCompiler.test.js'),
  path.join(__dirname, '..', 'tests', 'promptSecurity.test.js'),
  path.join(__dirname, '..', 'tests', 'promptStageContracts.test.js'),
  path.join(__dirname, '..', 'tests', 'promptGoldenSnapshots.test.js'),
  path.join(__dirname, '..', 'tests', 'personaModules.test.js'),
  path.join(__dirname, '..', 'tests', 'langgraphStoreSanitize.test.js'),
  path.join(__dirname, '..', 'tests', 'agentLoopV2.test.js'),
  path.join(__dirname, '..', 'tests', 'reactAgentLoop.test.js'),
  path.join(__dirname, '..', 'tests', 'persistNodeConfig.test.js'),
  path.join(__dirname, '..', 'tests', 'toolFailureDetection.test.js'),
  path.join(__dirname, '..', 'tests', 'toolCallMarkupRetry.test.js'),
  path.join(__dirname, '..', 'tests', 'httpClientQqImageInlining.test.js'),
  path.join(__dirname, '..', 'tests', 'webFetchFallback.test.js'),
  path.join(__dirname, '..', 'tests', 'nativeSkills.test.js'),
  path.join(__dirname, '..', 'tests', 'nativeSummarizeStock.test.js'),
  path.join(__dirname, '..', 'tests', 'nativeStocksAdvanced.test.js'),
  path.join(__dirname, '..', 'tests', 'nativeOntologyMcp.test.js'),
  path.join(__dirname, '..', 'tests', 'nativeWatchlistYoutube.test.js'),
  path.join(__dirname, '..', 'tests', 'nativePptImage.test.js'),
  path.join(__dirname, '..', 'tests', 'noExternalProcessSkillsSource.test.js'),
  path.join(__dirname, '..', 'tests', 'runtimeStreamingCoordinator.test.js'),
  path.join(__dirname, '..', 'tests', 'messageTaskControl.test.js'),
  path.join(__dirname, '..', 'tests', 'messageDispatchCoordinator.test.js'),
  path.join(__dirname, '..', 'tests', 'sessionContextSummaryStore.test.js'),
  path.join(__dirname, '..', 'tests', 'memeStore.test.js'),
  path.join(__dirname, '..', 'tests', 'memeManager.test.js'),
  path.join(__dirname, '..', 'tests', 'memeManagerSecurity.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryContextPriority.test.js'),
  path.join(__dirname, '..', 'tests', 'legacyMemoryFlushGuard.test.js'),
  path.join(__dirname, '..', 'tests', 'shortTermMemoryCompression.test.js'),
  path.join(__dirname, '..', 'tests', 'shortTermBridgeMemory.test.js'),
  path.join(__dirname, '..', 'tests', 'continuityState.test.js'),
  path.join(__dirname, '..', 'tests', 'contextCompactionReactiveRetry.test.js'),
  path.join(__dirname, '..', 'tests', 'contextStatsDispatchSnapshot.test.js'),
  path.join(__dirname, '..', 'tests', 'graphRestartRecallSource.test.js'),
  path.join(__dirname, '..', 'tests', 'aiRestartRecallSource.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryGovernanceSecurity.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryEpisodeArchive.test.js'),
  path.join(__dirname, '..', 'tests', 'selfImprovementRuntime.test.js'),
  path.join(__dirname, '..', 'tests', 'selfImprovementSource.test.js'),
  path.join(__dirname, '..', 'tests', 'styleProfileRuntime.test.js'),
  path.join(__dirname, '..', 'tests', 'socialContextRuntime.test.js'),
  path.join(__dirname, '..', 'tests', 'dailyJournalSegments.test.js'),
  path.join(__dirname, '..', 'tests', 'dailyJournalRollups.test.js'),
  path.join(__dirname, '..', 'tests', 'dailyJournalRetrieval.test.js'),
  path.join(__dirname, '..', 'tests', 'dailyJournalSummaryScheduler.test.js'),
  path.join(__dirname, '..', 'tests', 'dailyJournalBackfillSummaries.test.js'),
  path.join(__dirname, '..', 'tests', 'backfillJournalV3Events.test.js'),
  path.join(__dirname, '..', 'tests', 'dailyShareStore.test.js'),
  path.join(__dirname, '..', 'tests', 'dailyShareContent.test.js'),
  path.join(__dirname, '..', 'tests', 'dailyShareEngine.test.js'),
  path.join(__dirname, '..', 'tests', 'dailyShareFailureCooldown.test.js'),
  path.join(__dirname, '..', 'tests', 'qzoneGenerationPhase2.test.js'),
  path.join(__dirname, '..', 'tests', 'qzoneDiaryServicePhase2.test.js'),
  path.join(__dirname, '..', 'tests', 'dailyShareEnginePhase2.test.js'),
  path.join(__dirname, '..', 'tests', 'dailyShareSource.test.js'),
  path.join(__dirname, '..', 'tests', 'lifeSchedulerStore.test.js'),
  path.join(__dirname, '..', 'tests', 'lifeSchedulerEngine.test.js'),
  path.join(__dirname, '..', 'tests', 'lifeSchedulerSource.test.js'),
  path.join(__dirname, '..', 'tests', 'tickEngine.test.js'),
  path.join(__dirname, '..', 'tests', 'scheduledGreeting.test.js'),
  path.join(__dirname, '..', 'tests', 'greetingSchedule.test.js'),
  path.join(__dirname, '..', 'tests', 'sessionSummaryCommand.test.js'),
  path.join(__dirname, '..', 'tests', 'passiveAwareness.test.js'),
  path.join(__dirname, '..', 'tests', 'groupAwarenessStateOrder.test.js'),
  path.join(__dirname, '..', 'tests', 'groupMainModelStreamPolicy.test.js'),
  path.join(__dirname, '..', 'tests', 'groupMainModelStreamSource.test.js'),
  path.join(__dirname, '..', 'tests', 'router.test.js'),
  path.join(__dirname, '..', 'tests', 'routerHybrid.test.js'),
  path.join(__dirname, '..', 'tests', 'parser.test.js'),
  path.join(__dirname, '..', 'tests', 'anthropicParser.test.js'),
  path.join(__dirname, '..', 'tests', 'anthropicStreamUsageTracking.test.js'),
  path.join(__dirname, '..', 'tests', 'toolPolicy.test.js'),
  path.join(__dirname, '..', 'tests', 'napcatActionClient.test.js'),
  path.join(__dirname, '..', 'tests', 'qzoneClient.test.js'),
  path.join(__dirname, '..', 'tests', 'scheduledTaskTime.test.js'),
  path.join(__dirname, '..', 'tests', 'scheduledTaskStore.test.js'),
  path.join(__dirname, '..', 'tests', 'schedulerRuntime.test.js'),
  path.join(__dirname, '..', 'tests', 'qqActionService.test.js'),
  path.join(__dirname, '..', 'tests', 'qqActionServicePrivatePoke.test.js'),
  path.join(__dirname, '..', 'tests', 'mcpRuntime.test.js'),
  path.join(__dirname, '..', 'tests', 'toolRegistrySkills.test.js'),
  path.join(__dirname, '..', 'tests', 'arxivToolExecutor.test.js'),
  path.join(__dirname, '..', 'tests', 'toolRegistryMcp.test.js'),
  path.join(__dirname, '..', 'tests', 'localToolAccess.test.js'),
  path.join(__dirname, '..', 'tests', 'agentRuntime.test.js'),
  path.join(__dirname, '..', 'tests', 'agentLoop.test.js'),
  path.join(__dirname, '..', 'tests', 'humanizer.test.js'),
  path.join(__dirname, '..', 'tests', 'humanizerAgentSource.test.js'),
  path.join(__dirname, '..', 'tests', 'streaming.test.js'),
  path.join(__dirname, '..', 'tests', 'streamingFallbackSource.test.js'),
  path.join(__dirname, '..', 'tests', 'graphDispatch.test.js'),
  path.join(__dirname, '..', 'tests', 'langgraphRuntimeVersion.test.js'),
  path.join(__dirname, '..', 'tests', 'langgraphV2.test.js'),
  path.join(__dirname, '..', 'tests', 'agentGraphAnthropicSource.test.js'),
  path.join(__dirname, '..', 'tests', 'agentGraphAnthropicSystemMerge.test.js'),
  path.join(__dirname, '..', 'tests', 'graphStreamingDedup.test.js'),
  path.join(__dirname, '..', 'tests', 'promptManifestValidation.test.js'),
  path.join(__dirname, '..', 'tests', 'promptExamplesSync.test.js'),
  path.join(__dirname, '..', 'tests', 'runtimePrompts.test.js'),
  path.join(__dirname, '..', 'tests', 'runtimePromptAssetsSource.test.js'),
  path.join(__dirname, '..', 'tests', 'clarifyRetiredSource.test.js'),
  path.join(__dirname, '..', 'tests', 'routePromptPolicy.test.js'),
  path.join(__dirname, '..', 'tests', 'routeExecution.test.js'),
  path.join(__dirname, '..', 'tests', 'refusalReply.test.js'),
  path.join(__dirname, '..', 'tests', 'refusalReplySource.test.js'),
  path.join(__dirname, '..', 'tests', 'backgroundTaskRuntime.test.js'),
  path.join(__dirname, '..', 'tests', 'backgroundTaskControl.test.js'),
  path.join(__dirname, '..', 'tests', 'postReplyJobQueue.test.js'),
  path.join(__dirname, '..', 'tests', 'postReplyWorkerRuntime.test.js'),
  path.join(__dirname, '..', 'tests', 'continuousMessagePreprocessor.test.js'),
  path.join(__dirname, '..', 'tests', 'backgroundTaskSource.test.js'),
  path.join(__dirname, '..', 'tests', 'routeExecutionRefactorSource.test.js'),
  path.join(__dirname, '..', 'tests', 'routeExecutionSource.test.js'),
  path.join(__dirname, '..', 'tests', 'routeProfiles.test.js'),
  path.join(__dirname, '..', 'tests', 'routePromptPolicySource.test.js'),
  path.join(__dirname, '..', 'tests', 'toolReplyFormatting.test.js'),
  path.join(__dirname, '..', 'tests', 'promptCheck.test.js'),
  path.join(__dirname, '..', 'tests', 'promptCheckSource.test.js'),
  path.join(__dirname, '..', 'tests', 'messageFlowSource.test.js'),
  path.join(__dirname, '..', 'tests', 'messageReplyRuntime.test.js'),
  path.join(__dirname, '..', 'tests', 'messageHandlerPrivateStreaming.test.js'),
  path.join(__dirname, '..', 'tests', 'messageHandlerPrivateTypingPoke.test.js'),
  path.join(__dirname, '..', 'tests', 'messageHandlerPrivateConcurrencySource.test.js'),
  path.join(__dirname, '..', 'tests', 'privateChatWhitelist.test.js'),
  path.join(__dirname, '..', 'tests', 'privateChatAdminRouting.test.js'),
  path.join(__dirname, '..', 'tests', 'privateChatConcurrencyConfig.test.js'),
  path.join(__dirname, '..', 'tests', 'privateChatTestUserConfig.test.js'),
  path.join(__dirname, '..', 'tests', 'privateChatPrivilegeRouting.test.js'),
  path.join(__dirname, '..', 'tests', 'messageRouteFlowAdminGuard.test.js'),
  path.join(__dirname, '..', 'tests', 'messagePassiveAwarenessSource.test.js'),
  path.join(__dirname, '..', 'tests', 'memeManagerSource.test.js'),
  path.join(__dirname, '..', 'tests', 'messageDeduper.test.js'),
  path.join(__dirname, '..', 'tests', 'inboundConcurrency.test.js'),
  path.join(__dirname, '..', 'tests', 'messageHandlerInboundConcurrencySource.test.js'),
  path.join(__dirname, '..', 'tests', 'napcatMessageReader.test.js'),
  path.join(__dirname, '..', 'tests', 'qqRichMessage.test.js'),
  path.join(__dirname, '..', 'tests', 'streamingOrderSource.test.js'),
  path.join(__dirname, '..', 'tests', 'streamOptionsReference.test.js'),
  path.join(__dirname, '..', 'tests', 'modelCompat.test.js'),
  path.join(__dirname, '..', 'tests', 'modelProvider.test.js'),
  path.join(__dirname, '..', 'tests', 'mainModelFallback.test.js'),
  path.join(__dirname, '..', 'tests', 'mainModelRoleRouting.test.js'),
  path.join(__dirname, '..', 'tests', 'proactiveScheduleSource.test.js'),
  path.join(__dirname, '..', 'tests', 'webSearchResilienceSource.test.js'),
  path.join(__dirname, '..', 'tests', 'webSearchNoApiKeySource.test.js'),
  path.join(__dirname, '..', 'tests', 'checkAgentFailureDetectionSource.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryExtractionRetriesSource.test.js'),
  path.join(__dirname, '..', 'tests', 'modelTimeoutConfigSource.test.js'),
  path.join(__dirname, '..', 'tests', 'messageSendChunkingSource.test.js'),
  path.join(__dirname, '..', 'tests', 'messageHandlerInboundConcurrency.test.js')
];

function applyDefaultTestEnv(env = process.env) {
  const configuredTempRoot = String(env.TEST_TEMP_ROOT || '').trim();
  const testTempRoot = path.resolve(configuredTempRoot || DEFAULT_TEST_TEMP_ROOT);
  fs.mkdirSync(testTempRoot, { recursive: true });
  env.TEST_TEMP_ROOT = testTempRoot;
  env.TEMP = testTempRoot;
  env.TMP = testTempRoot;
  env.TMPDIR = testTempRoot;
  if (env.RESOURCE_PRESSURE_ENABLED === undefined || env.RESOURCE_PRESSURE_ENABLED === '') {
    env.RESOURCE_PRESSURE_ENABLED = 'false';
  }
  if (env.MODEL_TLS_IMPERSONATION_ENABLED === undefined || env.MODEL_TLS_IMPERSONATION_ENABLED === '') {
    env.MODEL_TLS_IMPERSONATION_ENABLED = 'false';
  }
  if (env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED === undefined || env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED === '') {
    env.MODEL_TLS_IMPERSONATION_STREAM_ENABLED = 'false';
  }
  if (env.MEMORY_CLI_RERANK_ENABLED === undefined || env.MEMORY_CLI_RERANK_ENABLED === '') {
    env.MEMORY_CLI_RERANK_ENABLED = 'false';
  }
  if (!String(env.NAPCAT_HTTP_API_BASE_URL || '').trim()) {
    env.NAPCAT_HTTP_API_BASE_URL = 'http://127.0.0.1:1';
  }
  return env;
}

function discoverDefaultTestFiles(projectRoot, testsDir, options = {}) {
  const gitResult = spawnSync(options.gitCommand || 'git', ['ls-files', '-z', '--', 'tests/*.test.js'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  if (!gitResult.error && gitResult.status === 0) {
    return String(gitResult.stdout || '')
      .split('\0')
      .filter((item) => item.endsWith('.test.js'))
      .map((item) => path.resolve(projectRoot, item))
      .filter((item) => fs.existsSync(item))
      .sort((a, b) => a.localeCompare(b));
  }

  return fs.existsSync(testsDir) ? listTestFiles(testsDir) : [];
}

const SERIAL_TEST_REASONS = Object.freeze({
  'logRotationCrossProcess.test.js': 'cross-process file rotation',
  'mainBotSingleInstanceLock.test.js': 'multi-process lock race',
  'periodicRestartScript.test.js': 'PowerShell process inspection',
  'postReplyQueueMergeRace.test.js': 'multi-process queue race',
  'postReplyWorkerPidFile.test.js': 'worker process lock',
  'postReplyWorkerSupervisor.test.js': 'worker supervisor process lifecycle',
  'restartBotScript.test.js': 'PowerShell process inspection',
  'runTestsDefaultEnv.test.js': 'nested test runner',
  'runTestsRunner.test.js': 'nested test runner and process-tree timeout',
  'windowsLogArchiveMaintenance.test.js': 'PowerShell file maintenance'
});
const SERIAL_TEST_FILES = new Set(Object.keys(SERIAL_TEST_REASONS));
const MAX_TEST_CONCURRENCY = 8;

function readPositiveInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function resolveTestConcurrency(value) {
  return Math.min(readPositiveInteger(value, 2), MAX_TEST_CONCURRENCY);
}

function waitForProcess(processHandle) {
  return new Promise((resolve) => {
    processHandle.once('error', (error) => resolve({ error, code: null }));
    processHandle.once('close', (code) => resolve({ error: null, code }));
  });
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('close', onClose);
  });
}

async function terminateProcessTree(child, options = {}) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;

  const platform = options.platform || process.platform;
  const spawnProcess = options.spawnProcess || spawn;
  const waitForSpawnedProcess = options.waitForProcess || waitForProcess;
  const waitForClose = options.waitForChildClose || waitForChildClose;
  if (platform === 'win32') {
    const killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    const result = await waitForSpawnedProcess(killer);
    if ((result.error || result.code !== 0) && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error && error.code !== 'ESRCH') child.kill('SIGKILL');
    }
  }

  if (await waitForClose(child, 2000)) return;
  child.kill('SIGKILL');
  if (!await waitForClose(child, 2000)) {
    throw new Error(`test process ${child.pid} did not exit after forced termination`);
  }
}

function runTestFile(file, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = readPositiveInteger(options.timeoutMs, 60000, 100);
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let timedOut = false;
    let terminationPromise = null;
    let timeout = null;
    const child = spawn(process.execPath, ['--unhandled-rejections=strict', file], {
      cwd: path.resolve(__dirname, '..'),
      env: applyDefaultTestEnv({ ...process.env }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', async (code, signal) => {
      clearTimeout(timeout);
      if (terminationPromise) {
        try {
          await terminationPromise;
        } catch (error) {
          spawnError = error;
        }
      }
      resolve({
        file,
        ok: !timedOut && !spawnError && code === 0,
        code,
        signal,
        error: spawnError,
        timedOut,
        timeoutMs,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr
      });
    });

    timeout = setTimeout(async () => {
      timedOut = true;
      terminationPromise = terminateProcessTree(child);
      await terminationPromise.catch((error) => {
        spawnError = error;
      });
    }, timeoutMs);
  });
}

async function runWithConcurrency(files, concurrency, options) {
  const results = new Array(files.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < files.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await runTestFile(files[index], options);
    }
  }

  const workerCount = Math.min(concurrency, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function isSerialTestFile(file) {
  return SERIAL_TEST_FILES.has(path.basename(file));
}

async function executeTestFiles(files, options) {
  const results = [];
  let parallelSegment = [];

  async function flushParallelSegment() {
    if (parallelSegment.length === 0) return;
    results.push(...await runWithConcurrency(parallelSegment, options.concurrency, options));
    parallelSegment = [];
  }

  for (const file of files) {
    if (!isSerialTestFile(file)) {
      parallelSegment.push(file);
      continue;
    }
    await flushParallelSegment();
    results.push(await runTestFile(file, options));
  }
  await flushParallelSegment();
  return results;
}

function resolveRequestedTestFile(item, testsDir) {
  const raw = String(item || '').trim();
  if (!raw) return '';
  const directPath = path.resolve(process.cwd(), raw);
  if (fs.existsSync(directPath)) return directPath;
  if (!raw.includes('/') && !raw.includes('\\')) {
    const byNamePath = path.join(testsDir, raw);
    if (fs.existsSync(byNamePath)) return byNamePath;
  }
  return directPath;
}

async function runAllTests() {
  const testsDir = path.join(__dirname, '..', 'tests');
  const requestedFiles = process.argv.slice(2)
    .filter((item) => String(item || '').trim() && !String(item || '').startsWith('--'))
    .map((item) => resolveRequestedTestFile(item, testsDir));
  const discoveredTestFiles = requestedFiles.length > 0
    ? []
    : discoverDefaultTestFiles(path.resolve(__dirname, '..'), testsDir);
  const runnableFiles = requestedFiles.length > 0
    ? requestedFiles.filter((candidate) => fs.existsSync(candidate))
    : discoveredTestFiles;
  if (requestedFiles.length > 0 && runnableFiles.length !== requestedFiles.length) {
    const missing = requestedFiles.filter((candidate) => !fs.existsSync(candidate));
    console.error('[test] missing requested files: ' + missing.join(', '));
    process.exit(1);
  }
  if (runnableFiles.length === 0) {
    console.error('[test] no test files found');
    process.exitCode = 1;
    return;
  }
  const options = {
    concurrency: resolveTestConcurrency(process.env.TEST_CONCURRENCY),
    timeoutMs: readPositiveInteger(process.env.TEST_FILE_TIMEOUT_MS, 60000, 100),
    slowTopN: readPositiveInteger(process.env.TEST_SLOW_TOP_N, 10)
  };
  const results = await executeTestFiles(runnableFiles, options);
  let failed = 0;

  for (const result of results) {
    const file = result.file;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.ok) {
      console.log(`[test] pass ${path.basename(file)} (${result.durationMs}ms)`);
      continue;
    }
    failed += 1;
    console.error(`[test] fail ${path.basename(file)}`);
    if (result.error) {
      console.error('       ' + (result.error.stack || String(result.error)));
    } else if (result.timedOut) {
      console.error(`       timed out after ${result.timeoutMs}ms`);
    } else {
      console.error(`       exited with code ${result.code}${result.signal ? ` signal ${result.signal}` : ''}`);
    }
  }

  const slowest = [...results]
    .sort((left, right) => right.durationMs - left.durationMs || left.file.localeCompare(right.file))
    .slice(0, Math.min(options.slowTopN, results.length));
  console.log(`[test] slowest ${slowest.length} files`);
  for (const result of slowest) {
    console.log(`       ${result.durationMs}ms ${path.basename(result.file)}`);
  }

  if (failed > 0) {
    process.exitCode = 1;
    return;
  }

  console.log('[test] all tests passed');
}

if (require.main === module) {
  runAllTests().catch((e) => {
    console.error('[test] runner crashed:', e && e.stack ? e.stack : String(e));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_TEST_TEMP_ROOT,
  MAX_TEST_CONCURRENCY,
  SERIAL_TEST_FILES,
  SERIAL_TEST_REASONS,
  applyDefaultTestEnv,
  discoverDefaultTestFiles,
  executeTestFiles,
  isSerialTestFile,
  listTestFiles,
  readPositiveInteger,
  resolveTestConcurrency,
  runTestFile,
  runWithConcurrency,
  terminateProcessTree
};



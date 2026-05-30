const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
  path.join(__dirname, '..', 'tests', 'memoryV3SessionRestore.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3PersonaCore.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3WeakEvidence.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3RelationshipFacet.test.js'),
  path.join(__dirname, '..', 'tests', 'memoryV3StyleFacet.test.js'),
  path.join(__dirname, '..', 'tests', 'personaMemoryState.test.js'),
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
  path.join(__dirname, '..', 'tests', 'directToolLoop.test.js'),
  path.join(__dirname, '..', 'tests', 'plannerV2Protocol.test.js'),
  path.join(__dirname, '..', 'tests', 'promptCompiler.test.js'),
  path.join(__dirname, '..', 'tests', 'promptSecurity.test.js'),
  path.join(__dirname, '..', 'tests', 'promptStageContracts.test.js'),
  path.join(__dirname, '..', 'tests', 'promptGoldenSnapshots.test.js'),
  path.join(__dirname, '..', 'tests', 'personaModules.test.js'),
  path.join(__dirname, '..', 'tests', 'langgraphStoreSanitize.test.js'),
  path.join(__dirname, '..', 'tests', 'agentLoopV2.test.js'),
  path.join(__dirname, '..', 'tests', 'dispatchRuntimeBinding.test.js'),
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
  path.join(__dirname, '..', 'tests', 'directChatPlannerQqTools.test.js'),
  path.join(__dirname, '..', 'tests', 'directChatSingleAuthority.test.js'),
  path.join(__dirname, '..', 'tests', 'directChatSingleAuthoritySource.test.js'),
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
  path.join(__dirname, '..', 'tests', 'plannerConfig.test.js'),
  path.join(__dirname, '..', 'tests', 'planStepIdTraceability.test.js'),
  path.join(__dirname, '..', 'tests', 'planTimeoutConsistency.test.js'),
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
  path.join(__dirname, '..', 'tests', 'messageSendChunkingSource.test.js')
  ,
  path.join(__dirname, '..', 'tests', 'messageHandlerInboundConcurrency.test.js')
];

function applyDefaultTestEnv(env = process.env) {
  if (env.RESOURCE_PRESSURE_ENABLED === undefined) {
    env.RESOURCE_PRESSURE_ENABLED = 'false';
  }
  return env;
}

function runTestFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--unhandled-rejections=strict', file], {
      cwd: path.resolve(__dirname, '..'),
      env: applyDefaultTestEnv({ ...process.env }),
      stdio: 'inherit',
      windowsHide: true
    });

    child.on('error', (error) => {
      resolve({ ok: false, error });
    });
    child.on('exit', (code, signal) => {
      resolve({ ok: code === 0, code, signal });
    });
  });
}

async function runAllTests() {
  let failed = 0;
  const requestedFiles = process.argv.slice(2)
    .filter((item) => String(item || '').trim() && !String(item || '').startsWith('--'))
    .map((item) => path.resolve(process.cwd(), item));
  const discoveredTestFiles = listTestFiles(path.join(__dirname, '..', 'tests'));
  const runnableFiles = requestedFiles.length > 0
    ? requestedFiles.filter((candidate) => fs.existsSync(candidate))
    : discoveredTestFiles.length > 0
    ? discoveredTestFiles
    : testFiles.filter((candidate) => fs.existsSync(candidate));
  if (requestedFiles.length > 0 && runnableFiles.length !== requestedFiles.length) {
    const missing = requestedFiles.filter((candidate) => !fs.existsSync(candidate));
    console.error('[test] missing requested files: ' + missing.join(', '));
    process.exit(1);
  }
  for (const file of runnableFiles) {
    const result = await runTestFile(file);
    if (result.ok) {
      console.log(`[test] pass ${path.basename(file)}`);
      continue;
    }
    failed += 1;
    console.error(`[test] fail ${path.basename(file)}`);
    if (result.error) {
      console.error('       ' + (result.error.stack || String(result.error)));
    } else {
      console.error(`       exited with code ${result.code}${result.signal ? ` signal ${result.signal}` : ''}`);
    }
  }

  if (failed > 0) {
    process.exit(1);
  }

  console.log('[test] all tests passed');
}

runAllTests().catch((e) => {
  console.error('[test] runner crashed:', e && e.stack ? e.stack : String(e));
  process.exit(1);
});



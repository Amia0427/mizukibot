const fs = require('fs');
const path = require('path');
const { getDatePartsInTz, todayStrInTz } = require('../utils/time');
const {
  favorites,
  chatHistory,
  shortTermMemory,
  updateFavor,
  saveData,
  hasFreshGroupBinding,
  clearGroupBindingsByGroupId,
  clearGroupBindingForUser
} = require('../utils/memory');
const { recordMemoryScope } = require('../utils/memoryScopeIndex');
const { askAIByGraph, runPersistInBackgroundFromCheckpoint } = require('../api/agentGraph');
const { extractJsonSafely } = require('../api/parser');
const {
  startSubagentBridgeCall
} = require('../api/subagentExecutor');
const { buildSessionId } = require('../api/subagentSessionManager');
const { humanizeReply } = require('../utils/humanizer');
const { classifyReplyFailure, isReplyFailure } = require('../utils/replyFailure');
const { sanitizeUserFacingText } = require('../utils/userFacingText');
const { buildRoutePromptBundle } = require('../utils/routePromptPolicy');
const { buildRuntimePrompt } = require('../utils/runtimePrompts');
const { getBackgroundTaskRuntime, summarizeReply: summarizeBackgroundReply } = require('../utils/backgroundTaskRuntime');
const { getHapiControlRuntime } = require('../utils/hapiControlRuntime');
const {
  buildToolReplyFormatInstruction,
  cleanToolReplyText,
  resolveToolReplyFormattingPreferences
} = require('../utils/toolReplyFormatting');
const {
  buildSubagentStyleGuardInstruction,
  buildSubagentExecutionGuidanceLine,
  buildSubagentExecutionPlanLines,
  buildSubagentToolReasonLine
} = require('../utils/subagentPrompting');
const {
  prepareSubagentFallbackReply,
  prepareSubagentOutputForReview
} = require('../utils/subagentStyleGuard');
const { isAtBot, detectIntentHybrid } = require('./router');
const routeExecution = require('./routeExecution');
const { buildRouteMetaEnvelope } = require('./executablePlan');
const { createMessageEventDeduper } = require('./messageDeduper');
const { createInboundConcurrencyController } = require('./inboundConcurrency');
const { createForegroundConcurrencyController } = require('./foregroundConcurrency');
const { isPrivilegedPrivateChatUser } = require('../utils/privilegedPrivateChat');
const { handlePassiveGroupAwareness } = require('./passiveGroupAwareness');
const {
  createContinuousMessagePreprocessor,
  cheapParseMessageEntry,
  resolveContinuousEntryDetails
} = require('./continuousMessagePreprocessor');
const {
  buildCuteRefusalReply,
  buildRefusalReply
} = require('./refusalReply');
const { resolveMessageDirectedContext } = require('./messageDirectedContext');
const { buildLlmPerception } = require('./llmPerception');
// source-compat note: passive flow is delegated, but the historical call site
// remains documented here for source regression coverage:
// const passiveResult = await handlePassiveGroupAwareness({
const {
  buildInboundMessageContext,
  resolveEffectiveBotQQ,
  shouldHandleNotice,
  shouldSkipNonGroupMessage,
  shouldSkipSelfMessage
} = require('./messageIngress');
const { runPassiveFlow } = require('./messagePassiveFlow');
const { createMessageReplyRuntime } = require('./messageReplyRuntime');
const { createMessageSideEffects } = require('./messageSideEffects');
const { createMessageRouteFlow } = require('./messageRouteFlow');
const {
  createDefaultHapiControlClientFactory,
  createMessageAdminCoordinator
} = require('./messageAdminCommands');
const { createMessageBackgroundTaskCoordinator } = require('./messageBackgroundTasks');
const { createMessageDispatchCoordinator } = require('./messageDispatchCoordinator');
const { createMessageTaskControlCoordinator } = require('./messageTaskControl');
const {
  appendInboundTimingLog,
  createInboundTimingLogger,
  createMessageTelemetryCoordinator,
  createReplyTelemetryBridge,
  getRawMessageTimestampMs
} = require('./messageTelemetry');
const { ensureCachedImageRef } = require('../utils/imageInputCache');
const {
  buildDirectedConversationSummary,
  createMessageVisualContext,
  buildVisualImageCollection,
  buildVisualImageCollectionDetails,
  resolveVisualInputFromContinuousMeta,
  resolveVisualInputFromContinuousMetaCore
} = require('./messageVisualContext');
const { buildImageModelConfig } = require('../utils/imageModelConfigResolver');
const { triggerRemoteRestart } = require('../utils/remoteRestart');
const {
  buildBridgeGuidancePrompt: buildBridgeGuidancePromptOwner,
  buildQqRichReplyPrompt: buildQqRichReplyPromptOwner,
  buildSafetyBoundaryRoutePrompt: buildSafetyBoundaryRoutePromptOwner,
  buildStreamingSegmentationPrompt: buildStreamingSegmentationPromptOwner,
  buildToolGuidancePrompt: buildToolGuidancePromptOwner,
  getRouteDisplayType: getRouteDisplayTypeOwner,
  shouldPreferQqRichReply: shouldPreferQqRichReplyOwner
} = require('./messagePromptComposer');
const {
  createProactiveGreetingFlow,
  shouldSendScheduledGreeting: proactiveShouldSendScheduledGreeting
} = require('./proactiveGreetingFlow');
const { planDirectChat } = require('./directChatPlanner');
const {
  PRIVATE_CHAT_WHITELIST_REPLY,
  PRIVATE_GROUP_ONLY_REPLY,
  buildBackgroundAckText,
  buildNoTaskControlText,
  buildQqRichMessagePayload,
  buildQzoneAutodraftPrompt,
  buildSessionStatusReply,
  buildSupplementedTaskText,
  canBypassPrivateGroupOnly,
  createStreamingDispatcher,
  getModelSegmentBreakIndex,
  getNaturalSplitIndex,
  getReplyChunkChars,
  getStreamMaxSegments,
  getStreamSendGapMs,
  isPrivateChatType,
  isPrivateChatUserAllowed,
  parseBackgroundControlCommand,
  parseQqRichMessage,
  shouldAutoDraftQzonePostRequest: shouldAutoDraftQzonePostRequestBase,
  shouldPreferQqRichReply,
  splitReplyForSend
} = require('../src/message');
const {
  cancelScheduledTask,
  createScheduledCommand,
  deleteScheduledTask,
  isAdminUser,
  listScheduledTasks,
  publishQzoneForContext,
  scheduleGroupMessage,
  sendGroupPoke,
  sendPrivatePoke,
  setMessageEmojiLike
} = require('../api/qqActionService');
const {
  armCotOnce,
  consumeCotOnce,
  getCotOnceTtlMs
} = require('../utils/cotOnceRuntime');
function getVisionCaptionWorkerModule() {
  return require('./visionCaptionWorker');
}

function getMessageFullSubagentModule() {
  return require('./messageFullSubagent');
}

function getMemeManagerModule() {
  return require('./memeManager');
}

function getDailyShareEngineModule() {
  return require('./dailyShareEngine');
}

function getCreateAgentExecutorModule() {
  return require('../api/createAgentExecutor');
}

function getQzoneDiaryServiceModule() {
  return require('../api/qzoneDiaryService');
}

function detectQzonePostDraftMode(...args) {
  return getQzoneDiaryServiceModule().detectQzonePostDraftMode(...args);
}

function generateBotDiaryDraft(...args) {
  return getQzoneDiaryServiceModule().generateBotDiaryDraft(...args);
}

function generateGenericQzoneDraft(...args) {
  return getQzoneDiaryServiceModule().generateGenericQzoneDraft(...args);
}

function normalizeGeneratedQzoneContent(...args) {
  return getQzoneDiaryServiceModule().normalizeGeneratedQzoneContent(...args);
}

function buildFullSubagentAllWorkersFailedReply(...args) {
  return getMessageFullSubagentModule().buildFullSubagentAllWorkersFailedReply(...args);
}

function buildFullSubagentCoordinatorPayload(...args) {
  return getMessageFullSubagentModule().buildFullSubagentCoordinatorPayload(...args);
}

function buildFullSubagentFallbackReply(...args) {
  return getMessageFullSubagentModule().buildFullSubagentFallbackReply(...args);
}

function buildFullSubagentReviewPayload(...args) {
  return getMessageFullSubagentModule().buildFullSubagentReviewPayload(...args);
}

function buildFullSubagentWorkerPrompt(...args) {
  return getMessageFullSubagentModule().buildFullSubagentWorkerPrompt(...args);
}

function chooseBestFullSubagentWorkerOutput(...args) {
  return getMessageFullSubagentModule().chooseBestFullSubagentWorkerOutput(...args);
}

function createMessageFullSubagentCoordinator(...args) {
  return getMessageFullSubagentModule().createMessageFullSubagentCoordinator(...args);
}

function normalizeFullSubagentPlan(...args) {
  return getMessageFullSubagentModule().normalizeFullSubagentPlan(...args);
}

function summarizeFullWorkerError(...args) {
  return getMessageFullSubagentModule().summarizeFullWorkerError(...args);
}

function consumePendingUploadFromMessage(...args) {
  return getMemeManagerModule().consumePendingUploadFromMessage(...args);
}

function handleAdminCommand(...args) {
  return getMemeManagerModule().handleAdminCommand(...args);
}

function maybeSendMemeFollowup(...args) {
  return getMemeManagerModule().maybeSendMemeFollowup(...args);
}
const {
  resolveShortTermSessionKey,
  getShortTermPresence,
  updateShortTermPresence
} = require('../utils/shortTermMemory');
const { createCheckpointStore, resolveThreadId } = require('../utils/langgraphV2Store');
const {
  saveSessionContextSummary,
  getSessionSummaryCooldownStatus
} = require('../utils/sessionContextSummaryStore');
const {
  cloneTraceForMeta,
  createRequestTrace,
  extractErrorCode,
  nextTracePhase
} = require('../utils/requestTrace');
const {
  generateSessionContextSummary
} = require('../utils/sessionContextSummaryRuntime');
const {
  captureCorrection,
  captureFeatureRequest,
  formatEventsAsText,
  formatGuidesAsText,
  formatPatternsAsText,
  formatRulesAsText,
  listGuides,
  listPatterns,
  listRecentEvents,
  listRules,
  searchEvents
} = require('../utils/selfImprovementRuntime');
const {
  formatStyleProfileAsText,
  recordHumanGroupMessage: recordStyleHumanGroupMessage
} = require('../utils/styleProfileRuntime');
const {
  formatRelationshipGraphAsText,
  formatSocialContextAsText,
  recordHumanGroupMessage: recordSocialHumanGroupMessage
} = require('../utils/socialContextRuntime');
const { appendGroupMessage, getLastReplyAt } = require('../utils/groupAwarenessState');
const { recordHumanInbound } = require('./initiativeState');
const { clearGroupMute, getGroupInitiativeState, setGroupMute } = require('./initiativeState');
const {
  sendGroupReply: sendSystemGroupReply
} = require('./systemGroupReply');

const shouldUseSubagentToolRoute = (...args) => routeExecution.shouldUseSubagentToolRoute(...args);
const shouldUseToolRoute = (...args) => routeExecution.shouldUseToolRoute(...args);
const promptComposerGetRouteDisplayType = (...args) => getRouteDisplayTypeOwner(...args);
const promptComposerBuildToolGuidancePrompt = (...args) => buildToolGuidancePromptOwner(...args);
const promptComposerBuildBridgeGuidancePrompt = (...args) => buildBridgeGuidancePromptOwner(...args);
const promptComposerBuildStreamingSegmentationPrompt = (...args) => buildStreamingSegmentationPromptOwner(...args);
const promptComposerShouldPreferQqRichReply = (...args) => shouldPreferQqRichReplyOwner(...args);
const promptComposerBuildQqRichReplyPrompt = (...args) => buildQqRichReplyPromptOwner(...args);
const promptComposerBuildSafetyBoundaryRoutePrompt = (...args) => buildSafetyBoundaryRoutePromptOwner(...args);
// source-compat anchors for admin route handling now owned by messageRouteFlow:
// cmd === 'learn_recent'
// cmd === 'learn_search'
// cmd === 'learn_patterns'
// cmd === 'learn_rules'
// cmd === 'learn_guide'


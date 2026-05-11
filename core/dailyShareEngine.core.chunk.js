const config = require('../config');
const { runQzoneAgent } = require('../api/qzoneAgentService');
const {
  cleanupLocalImage,
  tryGenerateBotDiaryQzoneImage
} = require('../api/qqActionService');
const { formatDateInTz, getDatePartsInTz } = require('../utils/time');
const {
  appendRecentContentFingerprint,
  appendRecentKey,
  appendRecentShare,
  DAILY_SHARE_TYPES,
  QZONE_TARGET_ID,
  ensureStateEntry,
  ensureTarget,
  loadState,
  loadTargets,
  resetGroupState,
  saveState,
  saveTargets,
  WINDOW_KEYS
} = require('./dailyShareStore');
const dailyShareKnowledgeProvider = require('./dailyShareKnowledgeProvider');
const {
  createDailyShareContent,
  getQzoneDaypartTone,
  normalizeDailyShareFingerprint,
  validateDailyShareOutput
} = require('./dailyShareContent');
const {
  MAX_RETRIES,
  buildVariationConstraintPrompt,
  chooseQzoneTypeByWeight,
  evaluateQzoneGenerationCandidate,
  getModelConfigForQzoneAttempt,
  getRecentQzoneHistory,
  recordQzoneGenerationHistory,
  sampleVariationProfile
} = require('./qzoneGenerationState');
const {
  CANDIDATE_COUNT,
  CANDIDATE_VARIANT_TYPES,
  PLAN_RETRY_LIMIT,
  appendQzoneGenerationLog,
  buildCandidatePrompt,
  buildPlanPrompt,
  buildTropeFingerprint,
  buildQzonePlan,
  getRecentFailureLikeEntries,
  normalizeTelemetryPayload,
  pickBestCandidate,
  summarizeQzoneDebug,
  summarizeQzoneWindowStats
} = require('./qzoneGenerationPhase2');
const {
  buildDailyShareUserInfo,
  recordSystemGroupSend,
  sendGroupReply
} = require('./systemGroupReply');
const { getRecentMessages } = require('../utils/groupAwarenessState');
const {
  buildConversationWindow,
  analyzeConversationWindow
} = require('./passiveGroupAwareness');
const {
  acquireInitiativeLock,
  evaluateInitiativePolicy,
  releaseInitiativeLock
} = require('./initiativePolicyEngine');
const { markInitiativeSent, setLastCycleKey } = require('./initiativeState');
const { isAdmin } = require('./router');
const { recordMemoryScope: defaultRecordMemoryScope } = require('../utils/memoryScopeIndex');
const { requestAssistantMessage } = require('../api/graphModelIO');
const { classifyReplyFailure, normalizeReplyText } = require('../utils/replyFailure');
const { getBackgroundPressureDelayMs, appendPerfEvent } = require('../utils/perfRuntime');

const WINDOW_LABELS = Object.freeze({
  morning: '鏃╅棿',
  afternoon: '鍗堝悗',
  night: '澶滈棿'
});

const WINDOW_STATUS_LABELS = Object.freeze({
  pending: '待执行',
  sent: '已发送',
  deferred: '已延期',
  skipped: '已跳过',
  failed: '澶辫触'
});

const GROUP_MAX_AUTO_SENDS_PER_WINDOW = 1;
const QZONE_MAX_AUTO_SENDS_PER_WINDOW = 2;
const QZONE_DAILY_SHARE_TYPES = Object.freeze(['greeting', 'mood', 'recommendation']);
let cachedDefaultRunMemoryCli;

function getDefaultRunMemoryCli() {
  if (cachedDefaultRunMemoryCli !== undefined) return cachedDefaultRunMemoryCli;
  try {
    const memoryCli = require('../utils/memoryCli');
    cachedDefaultRunMemoryCli = typeof memoryCli?.runMemoryCli === 'function'
      ? memoryCli.runMemoryCli
      : null;
  } catch (error) {
    cachedDefaultRunMemoryCli = null;
    console.warn('[daily-share] memory_cli unavailable:', error?.message || error);
  }
  return cachedDefaultRunMemoryCli;
}

function logDailyShare({ groupId = '', windowKey = '', type = '', reason = '', source = '', event = '' } = {}) {
  const payload = {
    groupId: String(groupId || ''),
    windowKey: String(windowKey || ''),
    type: String(type || ''),
    reason: String(reason || '')
  };
  if (source) payload.source = String(source);
  console.log(`[daily-share] ${String(event || 'event')}`, payload);
  try {
    if (!config.BUFFERED_EVENT_LOG_ENABLED) {
      const logLine = JSON.stringify({
        ts: Date.now(),
        day: formatDateInTz(new Date(), config.TIMEZONE),
        event: String(event || 'event'),
        groupId: String(groupId || ''),
        windowKey: String(windowKey || ''),
        type: String(type || ''),
        reason: String(reason || ''),
        source: String(source || '')
      });
      require('../utils/logRotation').appendFileWithRotation(config.DAILY_SHARE_EVENT_LOG_FILE, `${logLine}\n`, {
        encoding: 'utf-8'
      });
    } else {
      require('../utils/storeRegistry').getJsonLineWriter(config.DAILY_SHARE_EVENT_LOG_FILE, {
        debounceMs: Math.max(0, Number(config.HOT_STORE_DEBOUNCE_MS || 250) || 250),
        maxDelayMs: Math.max(0, Number(config.HOT_STORE_MAX_DELAY_MS || 2000) || 2000)
      }).append({
        ts: Date.now(),
        day: formatDateInTz(new Date(), config.TIMEZONE),
        event: String(event || 'event'),
        groupId: String(groupId || ''),
        windowKey: String(windowKey || ''),
        type: String(type || ''),
        reason: String(reason || ''),
        source: String(source || '')
      });
    }
  } catch (_) {}
}


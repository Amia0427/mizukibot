const config = require('../config');
const { publishQzonePost, publishQzonePostWithImages } = require('./qzoneClient');
const {
  generateBotDiaryDraft,
  generateGenericQzoneDraft,
  normalizeGeneratedQzoneContent
} = require('./qzoneDiaryService');
const {
  appendQzoneGenerationLog,
  evaluateImageConsistency,
  finalizeSuccessfulQzoneRecord,
  normalizeTelemetryPayload
} = require('../core/qzoneGenerationPhase2');
const { normalizeDailyShareFingerprint } = require('../core/qzoneGenerationState');

const DRAFT_ONLY = 'draft_only';
const AUTO_PUBLISH = 'auto_publish';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizePublishPolicy(value = '') {
  const policy = normalizeText(value).toLowerCase();
  return policy === AUTO_PUBLISH ? AUTO_PUBLISH : DRAFT_ONLY;
}

function normalizeAgentMode(value = '', fallback = 'agent') {
  const mode = normalizeText(value).toLowerCase();
  if (mode === 'bot_diary') return 'bot_diary';
  if (mode === 'generic_autodraft') return 'generic_autodraft';
  if (mode === 'manual') return 'manual';
  if (mode === 'agent') return 'agent';
  return fallback;
}

function normalizeQzoneAgentInput(input = {}) {
  if (typeof input === 'string') {
    return {
      mode: 'manual',
      content: normalizeText(input),
      hint: '',
      source: 'manual_qzone_post',
      type: 'manual_qzone_post',
      publishPolicy: DRAFT_ONLY
    };
  }

  const raw = input && typeof input === 'object' ? input : {};
  const mode = normalizeAgentMode(raw.mode, 'agent');
  return {
    mode,
    content: normalizeText(raw.content || raw.seedText),
    hint: normalizeText(raw.hint || raw.requestText || raw.content),
    source: normalizeText(raw.source || raw.qzoneSource || mode || 'agent_qzone'),
    type: normalizeText(raw.type || raw.qzoneType || mode || 'agent'),
    publishPolicy: normalizePublishPolicy(raw.publishPolicy),
    windowKey: normalizeText(raw.windowKey),
    shareType: normalizeText(raw.shareType),
    topicKey: normalizeText(raw.topicKey),
    topicGroup: normalizeText(raw.topicGroup),
    imageIntent: raw.imageIntent && typeof raw.imageIntent === 'object' ? raw.imageIntent : null,
    imagePromptHints: Array.isArray(raw.imagePromptHints)
      ? raw.imagePromptHints.map((item) => normalizeText(item)).filter(Boolean).slice(0, 8)
      : [],
    allowImage: raw.allowImage !== false
  };
}

function normalizeRouteGroupContext(context = {}) {
  const routeMeta = context.routeMeta && typeof context.routeMeta === 'object' ? context.routeMeta : {};
  return {
    userId: normalizeText(context.userId || routeMeta.userId),
    groupId: normalizeText(context.groupId || routeMeta.groupId || routeMeta.group_id)
  };
}

function buildTextPlanMeta(meta = {}, normalized = {}, options = {}) {
  return {
    ...meta,
    topicKey: normalizeText(meta.topicKey || normalized.topicKey || options.topicKey),
    topicGroup: normalizeText(meta.topicGroup || normalized.topicGroup || options.topicGroup),
    lens: normalizeText(meta.lens || options.lens),
    emotion: normalizeText(meta.emotion || options.emotion),
    anchor: normalizeText(meta.anchor || options.anchor),
    structure: normalizeText(meta.structure || options.structure),
    ending: normalizeText(meta.ending || options.ending),
    arc: normalizeText(meta.arc || options.arc),
    tempo: normalizeText(meta.tempo || options.tempo),
    distance: normalizeText(meta.distance || options.distance),
    imageIntent: meta.imageIntent || normalized.imageIntent || options.imageIntent || null,
    imagePromptHints: Array.isArray(meta.imagePromptHints) && meta.imagePromptHints.length
      ? meta.imagePromptHints
      : (normalized.imagePromptHints && normalized.imagePromptHints.length
        ? normalized.imagePromptHints
        : (Array.isArray(options.imagePromptHints) ? options.imagePromptHints : []))
  };
}

async function buildQzoneDraft(normalized = {}, context = {}, options = {}) {
  const groupId = normalizeText(context.groupId);
  const mode = normalizeAgentMode(normalized.mode, 'agent');

  if (mode === 'bot_diary') {
    const diaryDraft = await generateBotDiaryDraft({
      groupId,
      hint: normalized.hint
    }, {
      ...(options.diaryOptions || {}),
      groupId,
      memoryUserId: normalizeText((options.diaryOptions || {}).memoryUserId || config.BOT_QQ),
      requestAssistantMessage: options.requestAssistantMessage
    });
    if (!diaryDraft.ok) {
      return {
        ok: false,
        reason: diaryDraft.reason || 'bot diary generation failed',
        mode: 'bot_diary',
        content: '',
        meta: diaryDraft.meta || {}
      };
    }
    return {
      ok: true,
      mode: 'bot_diary',
      content: diaryDraft.content,
      meta: diaryDraft.meta || {}
    };
  }

  if (mode === 'manual' && normalized.content) {
    return {
      ok: true,
      mode: 'manual',
      content: normalized.content,
      meta: {
        mode: 'manual'
      }
    };
  }

  const drafted = await generateGenericQzoneDraft({
    requestText: normalized.hint || normalized.content,
    groupId
  }, {
    ...(options.diaryOptions || {}),
    requestAssistantMessage: options.requestAssistantMessage
  });
  const content = drafted.ok ? normalizeGeneratedQzoneContent(drafted.content) : '';
  if (!content) {
    return {
      ok: false,
      reason: drafted.reason || 'generic qzone draft generation failed',
      mode: 'generic_autodraft',
      content: '',
      meta: drafted.meta || {}
    };
  }
  return {
    ok: true,
    mode: mode === 'agent' ? 'generic_autodraft' : mode,
    content,
    meta: drafted.meta || {}
  };
}

function buildLogPlanSummary(meta = {}, options = {}) {
  const plan = meta.plan || {};
  const variation = plan.variationProfile || {};
  return {
    fingerprint: normalizeText(meta.planFingerprint || plan.fingerprint || '', 200).toLowerCase(),
    topicKey: normalizeText(meta.topicKey || options.topicKey || '', 80).toLowerCase(),
    topicGroup: normalizeText(meta.topicGroup || options.topicGroup || '', 80).toLowerCase(),
    lens: normalizeText(meta.lens || variation.lens || options.lens || '', 32).toLowerCase(),
    anchor: normalizeText(meta.anchor || variation.anchor || options.anchor || '', 32).toLowerCase(),
    structure: normalizeText(meta.structure || variation.structure || options.structure || '', 32).toLowerCase(),
    arc: normalizeText(meta.arc || variation.arc || options.arc || '', 32).toLowerCase(),
    tempo: normalizeText(meta.tempo || variation.tempo || options.tempo || '', 32).toLowerCase(),
    distance: normalizeText(meta.distance || variation.distance || options.distance || '', 32).toLowerCase(),
    spark: normalizeText(variation.spark || meta.spark || '', 32).toLowerCase(),
    socialMask: normalizeText(variation.socialMask || meta.socialMask || '', 32).toLowerCase(),
    freshnessMode: normalizeText(variation.freshnessMode || meta.freshnessMode || '', 32).toLowerCase(),
    voiceEdge: normalizeText(variation.voiceEdge || meta.voiceEdge || '', 32).toLowerCase(),
    tropeFingerprint: normalizeText(meta.tropeFingerprint || plan.tropeFingerprint || '', 120).toLowerCase()
  };
}

function buildImageMetaDefaults() {
  return {
    imageAttempted: false,
    imageGenerated: false,
    imageUploaded: false,
    imagePublishMode: 'text_only',
    imageFallbackStage: '',
    imageProviderUsed: ''
  };
}

function shouldAttemptAgentImage(meta = {}, normalized = {}) {
  if (!normalized.allowImage) return false;
  if (!config.BOT_DIARY_QZONE_IMAGE_ENABLED) return false;
  return Boolean(meta.imageIntent || (Array.isArray(meta.imagePromptHints) && meta.imagePromptHints.length));
}

async function prepareQzoneImage(content = '', meta = {}, normalized = {}, helpers = {}, options = {}) {
  const result = buildImageMetaDefaults();
  if (!shouldAttemptAgentImage(meta, normalized)) return { imageMeta: result, localImagePath: '' };

  const prepare = typeof helpers.tryGenerateBotDiaryQzoneImage === 'function'
    ? helpers.tryGenerateBotDiaryQzoneImage
    : null;
  if (!prepare) {
    result.imagePublishMode = 'image_degraded';
    result.imageFallbackStage = 'image_helper_missing';
    return { imageMeta: result, localImagePath: '' };
  }

  const preparedImage = await prepare(content, meta, {
    buildProviderConfig: options.buildProviderConfig,
    drawPicture: options.drawPicture,
    downloadImageToLocal: options.downloadImageToLocal,
    httpClient: options.httpClient,
    downloadTimeoutMs: options.downloadTimeoutMs,
    maxBytes: options.maxBytes,
    tmpDir: options.tmpDir
  });
  const imageMeta = {
    imageAttempted: preparedImage.attempted,
    imageGenerated: preparedImage.generated,
    imageUploaded: false,
    imagePublishMode: preparedImage.imagePublishMode,
    imageFallbackStage: preparedImage.imageFallbackStage,
    imageProviderUsed: preparedImage.imageProviderUsed
  };
  let localImagePath = preparedImage.imagePath || '';

  if (meta?.imageIntent) {
    const imageConsistency = evaluateImageConsistency({
      text: content,
      plan: {
        imageIntent: meta.imageIntent,
        sceneAnchors: Array.isArray(meta.imagePromptHints) ? meta.imagePromptHints : []
      }
    });
    imageMeta.imageConsistencyScore = imageConsistency.score;
    imageMeta.imageVisualFingerprint = imageConsistency.visualFingerprint;
    if (!imageConsistency.consistent) {
      localImagePath = '';
      imageMeta.imagePublishMode = 'image_degraded';
      imageMeta.imageFallbackStage = 'image_consistency';
    }
  }

  return { imageMeta, localImagePath };
}

function appendAgentLog({ status, source, type, groupId, content, meta, imageMeta, failureReasons = [], options = {} }) {
  appendQzoneGenerationLog(normalizeTelemetryPayload({
    source,
    type,
    groupId,
    status,
    selectedFingerprint: normalizeDailyShareFingerprint ? normalizeDailyShareFingerprint(content) : '',
    selectedScore: Number.isFinite(Number(meta.selectedScore)) ? Number(meta.selectedScore) : 0,
    similarity: Number.isFinite(Number(meta.similarity)) ? Number(meta.similarity) : 0,
    noveltyScore: Number.isFinite(Number(meta.noveltyScore)) ? Number(meta.noveltyScore) : 0,
    tropeCollisionScore: Number.isFinite(Number(meta.tropeCollisionScore)) ? Number(meta.tropeCollisionScore) : 0,
    circleNaturalnessScore: Number.isFinite(Number(meta.circleNaturalnessScore)) ? Number(meta.circleNaturalnessScore) : 0,
    edgeTensionScore: Number.isFinite(Number(meta.edgeTensionScore)) ? Number(meta.edgeTensionScore) : 0,
    imagePublishMode: normalizeText(imageMeta.imagePublishMode || '', 32).toLowerCase(),
    imageConsistencyScore: Number.isFinite(Number(imageMeta.imageConsistencyScore)) ? Number(imageMeta.imageConsistencyScore) : 0,
    failureReasons,
    planSummary: buildLogPlanSummary(meta, options),
    candidates: Array.isArray(meta.candidates) ? meta.candidates : []
  }));
}

function finalizeAgentSuccess({ source, type, content, meta, imageMeta, options = {}, now = Date.now() }) {
  finalizeSuccessfulQzoneRecord({
    source: source === 'manual' ? 'manual_qzone_post' : source,
    text: content,
    type,
    topicKey: normalizeText(meta.topicKey || options.topicKey || ''),
    topicGroup: normalizeText(meta.topicGroup || options.topicGroup || ''),
    variationProfile: {
      lens: normalizeText(meta.lens || options.lens || ''),
      emotion: normalizeText(meta.emotion || options.emotion || ''),
      anchor: normalizeText(meta.anchor || options.anchor || ''),
      structure: normalizeText(meta.structure || options.structure || ''),
      ending: normalizeText(meta.ending || options.ending || ''),
      arc: normalizeText(meta.arc || options.arc || ''),
      tempo: normalizeText(meta.tempo || options.tempo || ''),
      distance: normalizeText(meta.distance || options.distance || '')
    },
    plan: meta.plan || {
      type,
      theme: meta.topicKey ? { key: normalizeText(meta.topicKey || '', 80).toLowerCase() } : null,
      variationProfile: {
        lens: normalizeText(meta.lens || options.lens || ''),
        emotion: normalizeText(meta.emotion || options.emotion || ''),
        anchor: normalizeText(meta.anchor || options.anchor || ''),
        structure: normalizeText(meta.structure || options.structure || ''),
        ending: normalizeText(meta.ending || options.ending || ''),
        arc: normalizeText(meta.arc || options.arc || ''),
        tempo: normalizeText(meta.tempo || options.tempo || ''),
        distance: normalizeText(meta.distance || options.distance || '')
      },
      imageIntent: meta.imageIntent || null
    },
    tropeFingerprint: normalizeText(meta.tropeFingerprint || meta.plan?.tropeFingerprint || ''),
    at: now
  });
}

async function runQzoneAgent(input = {}, context = {}, options = {}) {
  const normalized = normalizeQzoneAgentInput(input);
  const groupContext = normalizeRouteGroupContext(context);
  const assertAdmin = typeof options.assertAdmin === 'function' ? options.assertAdmin : null;
  if (!groupContext.groupId) throw new Error('group context required');
  if (assertAdmin) assertAdmin(groupContext.userId);

  const draft = await buildQzoneDraft(normalized, groupContext, options);
  if (!draft.ok) {
    return {
      ok: false,
      published: false,
      draftOnly: normalized.publishPolicy !== AUTO_PUBLISH,
      text: `failed\nreason: ${draft.reason || 'QZone draft generation failed'}`,
      content: '',
      mode: draft.mode || normalized.mode,
      reason: draft.reason || 'QZone draft generation failed',
      source: normalized.source,
      meta: draft.meta || {}
    };
  }

  const content = normalizeGeneratedQzoneContent(draft.content);
  const source = normalizeText(options.qzoneSource || normalized.source || draft.mode || 'agent_qzone').toLowerCase() || 'agent_qzone';
  const type = normalizeText(options.qzoneType || normalized.type || draft.mode || 'agent').toLowerCase() || 'agent';
  const meta = buildTextPlanMeta(draft.meta || {}, normalized, options);
  const imageMeta = buildImageMetaDefaults();
  const autoPublishEnabled = options.qzoneAutoPublishEnabled !== undefined
    ? options.qzoneAutoPublishEnabled
    : config.QZONE_AUTO_PUBLISH_ENABLED;
  const shouldPublish = normalized.publishPolicy === AUTO_PUBLISH && autoPublishEnabled;

  if (!shouldPublish) {
    const reason = normalized.publishPolicy === AUTO_PUBLISH
      ? 'QZone auto publish disabled'
      : 'QZone draft generated but not published';
    appendAgentLog({
      status: 'drafted',
      source: source === 'manual' ? 'manual_qzone_post' : source,
      type,
      groupId: groupContext.groupId,
      content,
      meta,
      imageMeta,
      options
    });
    return {
      ok: true,
      published: false,
      draftOnly: true,
      text: `drafted\nreason: ${reason}\ngroup: ${groupContext.groupId}\ncontent:\n${content}`,
      content,
      mode: draft.mode || normalized.mode,
      reason,
      source: source === 'manual' ? 'manual_qzone_post' : source,
      meta: {
        ...meta,
        ...imageMeta
      }
    };
  }

  const publishQzone = typeof options.publishQzonePost === 'function'
    ? options.publishQzonePost
    : publishQzonePost;
  const publishQzoneImages = typeof options.publishQzonePostWithImages === 'function'
    ? options.publishQzonePostWithImages
    : publishQzonePostWithImages;
  const helpers = options.helpers && typeof options.helpers === 'object' ? options.helpers : {};

  let localImagePath = '';
  let publishResult = null;
  let publishImageMeta = imageMeta;
  if (normalized.allowImage) {
    const prepared = await prepareQzoneImage(content, meta, normalized, helpers, options);
    localImagePath = prepared.localImagePath;
    publishImageMeta = prepared.imageMeta;
  }

  try {
    if (localImagePath) {
      const imagePublish = await publishQzoneImages({
        content,
        imagePaths: [localImagePath]
      });
      if (imagePublish.success) {
        publishResult = imagePublish;
        publishImageMeta.imageUploaded = true;
        publishImageMeta.imagePublishMode = 'image_attached';
      } else if (!imagePublish.uncertain) {
        publishImageMeta.imagePublishMode = 'image_degraded';
        publishImageMeta.imageFallbackStage = normalizeText(imagePublish.stage || 'image_publish');
      } else {
        appendAgentLog({
          status: 'failed',
          source: source === 'manual' ? 'manual_qzone_post' : source,
          type,
          groupId: groupContext.groupId,
          content,
          meta,
          imageMeta: publishImageMeta,
          failureReasons: [imagePublish.reason || 'QZone image publish failed'],
          options
        });
        return {
          ok: false,
          published: false,
          draftOnly: false,
          text: `failed\nreason: ${imagePublish.reason || 'QZone image publish failed'}`,
          content,
          mode: draft.mode || normalized.mode,
          reason: imagePublish.reason || 'QZone image publish failed',
          source: imagePublish.source || '',
          meta: {
            ...meta,
            ...publishImageMeta
          }
        };
      }
    }

    if (!publishResult) {
      publishResult = await publishQzone(content);
    }
  } finally {
    if (typeof helpers.cleanupLocalImage === 'function') {
      await Promise.resolve(helpers.cleanupLocalImage(localImagePath));
    }
  }

  if (!publishResult.success) {
    appendAgentLog({
      status: 'failed',
      source: source === 'manual' ? 'manual_qzone_post' : source,
      type,
      groupId: groupContext.groupId,
      content,
      meta,
      imageMeta: publishImageMeta,
      failureReasons: [publishResult.reason || 'QZone publish failed'],
      options
    });
    return {
      ok: false,
      published: false,
      draftOnly: false,
      text: `failed\nreason: ${publishResult.reason || 'QZone publish failed'}`,
      content,
      mode: draft.mode || normalized.mode,
      reason: publishResult.reason || 'QZone publish failed',
      source: publishResult.source || '',
      meta: {
        ...meta,
        ...publishImageMeta
      }
    };
  }

  const finalSource = source === 'manual' ? 'manual_qzone_post' : source;
  finalizeAgentSuccess({
    source: finalSource,
    type,
    content,
    meta,
    imageMeta: publishImageMeta,
    options,
    now: options.now || Date.now()
  });
  appendAgentLog({
    status: 'sent',
    source: finalSource,
    type,
    groupId: groupContext.groupId,
    content,
    meta,
    imageMeta: publishImageMeta,
    options
  });

  return {
    ok: true,
    published: true,
    draftOnly: false,
    text: `success\nreason: ${publishResult.reason || 'QZone publish success'}\ngroup: ${groupContext.groupId}`,
    content,
    mode: draft.mode || normalized.mode,
    reason: publishResult.reason || 'QZone publish success',
    source: publishResult.source || '',
    meta: {
      ...meta,
      ...publishImageMeta
    }
  };
}

module.exports = {
  AUTO_PUBLISH,
  DRAFT_ONLY,
  normalizeAgentMode,
  normalizePublishPolicy,
  normalizeQzoneAgentInput,
  runQzoneAgent
};

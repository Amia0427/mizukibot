const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-qzone-phase2-'));
process.env.DATA_DIR = tempRoot;
process.env.QZONE_GENERATION_HISTORY_FILE = path.join(tempRoot, 'qzone_generation_history.json');
process.env.QZONE_GENERATION_LOG_FILE = path.join(tempRoot, 'qzone_generation_log.json');
process.env.QZONE_VISUAL_HISTORY_FILE = path.join(tempRoot, 'qzone_visual_history.json');
process.env.API_KEY = process.env.API_KEY || 'test-key';

const { recordQzoneGenerationHistory } = require('../core/qzoneGenerationState');
const {
  appendQzoneGenerationLog,
  buildQzonePlan,
  CANDIDATE_VARIANT_TYPES,
  evaluateImageConsistency,
  pickBestCandidate,
  summarizeQzoneDebug,
  summarizeQzoneWindowStats
} = require('../core/qzoneGenerationPhase2');

recordQzoneGenerationHistory({
  source: 'daily_share',
  text: '我把窗边那点风声听了一会儿，忽然就不想把话说满了。',
  topicKey: 'daily.window.pause',
  topicGroup: 'daily',
  variationProfile: {
    lens: 'scene',
    emotion: 'blank',
    anchor: 'window',
    structure: 'two_step',
    ending: 'soft_close',
    arc: 'sink',
    tempo: 'drifting',
    distance: 'self_only'
  },
  type: 'mood',
  at: Date.now() - 1000
});

const plan = buildQzonePlan({
  source: 'bot_diary',
  type: 'bot_diary',
  windowKey: 'night',
  groupId: 'g1',
  today: '2026-04-15',
  planAttempt: 0,
  now: Date.now(),
  recentHistory: require('../core/qzoneGenerationState').getRecentQzoneHistory(),
  recentFailures: [],
  allowImage: true,
  targetLength: '80-180'
});

assert.ok(plan.fingerprint);
assert.ok(plan.variationProfile.arc);
assert.ok(plan.variationProfile.tempo);
assert.ok(plan.variationProfile.distance);
assert.ok(plan.variationProfile.spark);
assert.ok(plan.variationProfile.socialMask);
assert.ok(plan.variationProfile.freshnessMode);
assert.ok(plan.variationProfile.voiceEdge);
assert.ok(plan.tropeFingerprint);
assert.ok(plan.theme && plan.theme.key);
assert.ok(require('../core/qzoneGenerationPhase2').buildPlanPrompt(plan).includes('moment_texture'));

const candidates = [
  {
    plan,
    variantType: CANDIDATE_VARIANT_TYPES[0],
    text: '我把窗帘拉开一点以后，灯光刚好落在杯口上，整个人也没那么硬了。',
    rejected: false,
    rejectionReason: ''
  },
  {
    plan,
    variantType: CANDIDATE_VARIANT_TYPES[1],
    text: '今天也想分享一下我的心情。',
    rejected: false,
    rejectionReason: ''
  }
];

const picked = pickBestCandidate(candidates, {
  source: 'bot_diary',
  recentHistory: require('../core/qzoneGenerationState').getRecentQzoneHistory(),
  plan
});
assert.ok(picked.selected);
assert.ok(picked.selected.text.includes('窗'));
assert.ok(typeof picked.selected.circleNaturalnessScore === 'number');
assert.ok(typeof picked.selected.tropeCollisionScore === 'number');

const polishedPicked = pickBestCandidate([
  {
    plan,
    variantType: CANDIDATE_VARIANT_TYPES[0],
    text: '分享一下我最近想说的心情，生活教会我每一天都要认真面对。',
    rejected: false,
    rejectionReason: ''
  },
  {
    plan,
    variantType: CANDIDATE_VARIANT_TYPES[0],
    text: '刚刚把杯子放回桌边，结果灯一暗，我又懒得解释自己为什么突然不说话了。',
    rejected: false,
    rejectionReason: ''
  }
], {
  source: 'bot_diary',
  recentHistory: require('../core/qzoneGenerationState').getRecentQzoneHistory(),
  plan
});
assert.ok(polishedPicked.selected.text.includes('刚刚'));

const consistency = evaluateImageConsistency({
  text: '我把窗帘拉开一点以后，灯光刚好落在杯口上。',
  plan
});
assert.ok(typeof consistency.score === 'number');

appendQzoneGenerationLog({
  source: 'bot_diary',
  type: 'bot_diary',
  groupId: 'g1',
  status: 'sent',
  selectedFingerprint: picked.selected.fingerprint,
  selectedScore: picked.selected.score,
  similarity: picked.selected.similarity,
  noveltyScore: picked.selected.noveltyScore,
  tropeCollisionScore: picked.selected.tropeCollisionScore,
  circleNaturalnessScore: picked.selected.circleNaturalnessScore,
  edgeTensionScore: picked.selected.edgeTensionScore,
  imagePublishMode: 'image_attached',
  imageConsistencyScore: consistency.score,
  failureReasons: [],
  planSummary: {
    fingerprint: plan.fingerprint,
    topicKey: plan.theme.key,
    topicGroup: String(plan.theme.key).split('.')[0],
    lens: plan.variationProfile.lens,
    anchor: plan.variationProfile.anchor,
    structure: plan.variationProfile.structure,
    arc: plan.variationProfile.arc,
    tempo: plan.variationProfile.tempo,
    distance: plan.variationProfile.distance,
    spark: plan.variationProfile.spark,
    socialMask: plan.variationProfile.socialMask,
    freshnessMode: plan.variationProfile.freshnessMode,
    voiceEdge: plan.variationProfile.voiceEdge,
    tropeFingerprint: plan.tropeFingerprint
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
});

assert.ok(summarizeQzoneDebug(10).includes('来源分布'));
assert.ok(summarizeQzoneDebug(10).includes('常见套路'));
assert.ok(summarizeQzoneDebug(10).includes('候选风味'));
assert.ok(summarizeQzoneWindowStats(7).includes('QZone phase2 统计'));

console.log('qzoneGenerationPhase2.test.js passed');

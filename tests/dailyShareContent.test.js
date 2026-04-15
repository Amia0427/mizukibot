const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-dailyshare-content-'));
process.env.DATA_DIR = tempRoot;
process.env.QZONE_GENERATION_HISTORY_FILE = path.join(tempRoot, 'qzone_generation_history.json');
process.env.API_KEY = process.env.API_KEY || 'test-key';

const {
  buildVariationConstraintPrompt,
  buildVariationProfilePrompt,
  chooseQzoneTopic,
  evaluateQzoneGenerationCandidate,
  recordQzoneGenerationHistory,
  sampleVariationProfile
} = require('../core/qzoneGenerationState');

const historyBase = [
  {
    source: 'daily_share',
    text: '我把窗边那点风声听了一会儿，忽然就不太想说话了。',
    topicKey: 'daily-weather',
    topicGroup: 'daily',
    variationProfile: {
      lens: 'scene',
      emotion: 'blank',
      anchor: 'window',
      structure: 'two_step',
      ending: 'soft_close'
    },
    type: 'mood',
    at: Date.now() - 2000
  },
  {
    source: 'bot_diary',
    text: '我刚把耳机摘下来，房间一下子安静得有点过分。',
    topicKey: 'media-playlist',
    topicGroup: 'media',
    variationProfile: {
      lens: 'object',
      emotion: 'soft',
      anchor: 'music',
      structure: 'short_then_turn',
      ending: 'hanging'
    },
    type: 'bot_diary',
    at: Date.now() - 1000
  }
];

for (const item of historyBase) {
  recordQzoneGenerationHistory(item);
}

const history = require('../core/qzoneGenerationState').getRecentQzoneHistory();
const profile = sampleVariationProfile({
  source: 'daily_share',
  type: 'mood',
  windowKey: 'night',
  groupId: '__qzone__',
  today: '2026-04-15',
  attempt: 0,
  now: Date.now(),
  recentHistory: history
});

assert.ok(profile.lens && profile.anchor && profile.structure && profile.ending);
assert.notStrictEqual(profile.anchor, 'window');
assert.notStrictEqual(profile.structure, 'two_step');

const variationPrompt = buildVariationProfilePrompt(profile);
assert.ok(variationPrompt.includes('[本次写法槽位]'));

const constraintPrompt = buildVariationConstraintPrompt({ recentHistory: history });
assert.ok(constraintPrompt.includes('[最近禁用模式]'));
assert.ok(constraintPrompt.includes('window') || constraintPrompt.includes('music'));

const chosenTopic = chooseQzoneTopic({
  now: Date.now(),
  recentHistory: history,
  surface: 'qzone',
  seed: 'topic-test'
});
assert.ok(chosenTopic.topic);
assert.ok(chosenTopic.topic.key);
assert.notStrictEqual(chosenTopic.topicGroup, 'media');

const duplicateCandidate = evaluateQzoneGenerationCandidate(
  '我刚把耳机摘下来，房间一下子安静得有点过分。',
  {
    recentHistory: history,
    variationProfile: {
      lens: 'object',
      anchor: 'music',
      structure: 'short_then_turn'
    }
  }
);
assert.strictEqual(duplicateCandidate.ok, false);

const freshCandidate = evaluateQzoneGenerationCandidate(
  '我把杯子捧热了半天，最后还是决定把窗帘拉开一点。',
  {
    recentHistory: history,
    variationProfile: {
      lens: 'action',
      anchor: 'drink',
      structure: 'turn_then_drop'
    }
  }
);
assert.strictEqual(freshCandidate.ok, true);

console.log('dailyShareContent.test.js passed');
